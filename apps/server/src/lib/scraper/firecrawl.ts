import { z } from 'zod';
import { IngestionError } from '../../errors/ingestion-error.js';
import { readJson, request } from '../http-request.js';
import type { ScraperProvider } from './types.js';

export interface FirecrawlConfig {
  apiKey: string;
  /** For the whole call; Firecrawl is told to give up slightly earlier. */
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
/** How much earlier Firecrawl should stop than our own timeout, so we get its answer. */
const TIMEOUT_MARGIN_MS = 5_000;

const title = z.union([z.string(), z.array(z.string())]).nullish();

const scrapeResponse = z.object({
  success: z.literal(true),
  data: z.object({
    markdown: z.string().nullish(),
    metadata: z.object({ title, statusCode: z.number().nullish() }).nullish(),
  }),
});

const errorResponse = z.object({
  success: z.literal(false).optional(),
  error: z.string().nullish(),
  code: z.string().nullish(),
});

const messages = {
  unreachable: "We couldn't reach the website reader. Please try again.",
  busy: 'The website reader is busy right now. Please try again in a few minutes.',
  slow: 'The website took too long to respond. Please try again.',
  notFound: "This page doesn't exist (the site returned “not found”). Check the link.",
  noSuchSite: "This website's address couldn't be found. Check the link.",
  blocked: "This site doesn't allow automated reading or needs a login, so it can't be added.",
  siteDown: 'The website is having problems right now. Please try again later.',
  empty: 'No readable text was found on this page.',
  unsupported: "This link can't be read as a web page.",
  failed: "We couldn't read this website. Please try again later.",
};

/** The target site's own HTTP status, reported by Firecrawl alongside the content. */
function assertPageStatus(status: number | null | undefined): void {
  if (status === null || status === undefined || status < 400) return;
  if (status === 404 || status === 410) {
    throw IngestionError.permanent('PAGE_NOT_FOUND', messages.notFound);
  }
  if (status === 401 || status === 403 || status === 451) {
    throw IngestionError.permanent('PAGE_BLOCKED', messages.blocked);
  }
  if (status === 408 || status === 429 || status >= 500) {
    throw IngestionError.transient(messages.siteDown);
  }
  throw IngestionError.permanent('PROCESSING_FAILED', messages.failed);
}

/**
 * Firecrawl's own failure (it could not, or would not, scrape). Its `code` says more than the
 * HTTP status: a failed scrape can come back as a 200 with `success: false`.
 */
function scrapeFailure(status: number, body: unknown): IngestionError {
  const parsed = errorResponse.safeParse(body);
  const code = parsed.success ? (parsed.data.code ?? '') : '';
  const cause = new Error(
    `Firecrawl ${status}${code ? ` ${code}` : ''}: ${(parsed.success && parsed.data.error) || 'no error message'}`,
  );

  if (/dns/i.test(code)) {
    return IngestionError.permanent('PAGE_NOT_FOUND', messages.noSuchSite, { cause });
  }
  if (/unsupported/i.test(code)) {
    return IngestionError.permanent('PROCESSING_FAILED', messages.unsupported, { cause });
  }
  if (status === 408 || /timeout/i.test(code)) {
    return IngestionError.transient(messages.slow, { cause });
  }
  // A failed scrape without a telling status or code: the site may just be having a bad moment.
  if (status < 400) return IngestionError.transient(messages.siteDown, { cause });
  if (status === 409 || status === 429) return IngestionError.transient(messages.busy, { cause });
  if (status >= 500) return IngestionError.transient(messages.unreachable, { cause });
  if (status === 403) return IngestionError.permanent('PAGE_BLOCKED', messages.blocked, { cause });
  if (status === 400) {
    return IngestionError.permanent('PROCESSING_FAILED', messages.unsupported, { cause });
  }
  // 401 / 402: our key or credits. Retrying won't fix it; the cause is logged for the owner.
  return IngestionError.permanent('PROCESSING_FAILED', messages.failed, { cause });
}

export function createFirecrawlScraper(config: FirecrawlConfig): ScraperProvider {
  const endpoint = new URL('/v2/scrape', config.baseUrl ?? DEFAULT_BASE_URL);

  return {
    async scrape(url) {
      const response = await request(
        endpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url,
            formats: ['markdown'],
            onlyMainContent: true,
            timeout: Math.max(1_000, config.timeoutMs - TIMEOUT_MARGIN_MS),
          }),
        },
        {
          fetch: config.fetch ?? fetch,
          timeoutMs: config.timeoutMs,
          unreachableMessage: messages.unreachable,
        },
      );

      const body = await readJson(response);
      const failed = errorResponse.safeParse(body);
      if (!response.ok || (failed.success && failed.data.success === false)) {
        throw scrapeFailure(response.status, body);
      }

      const parsed = scrapeResponse.safeParse(body);
      if (!parsed.success) {
        throw IngestionError.transient(messages.unreachable, {
          cause: new Error('Firecrawl returned an unexpected response', { cause: parsed.error }),
        });
      }

      const { markdown, metadata } = parsed.data.data;
      assertPageStatus(metadata?.statusCode);

      const content = markdown?.trim() ?? '';
      if (content === '') throw IngestionError.permanent('NO_TEXT', messages.empty);

      const rawTitle = Array.isArray(metadata?.title) ? metadata.title[0] : metadata?.title;
      return { title: rawTitle?.trim() || null, markdown: content };
    },
  };
}
