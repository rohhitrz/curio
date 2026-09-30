import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ExtractionError } from '../../errors/extraction-error.js';
import { readJson, request } from '../http-request.js';
import type { Transcript, TranscriptProvider, TranscriptSegment } from './types.js';

export interface SupadataConfig {
  apiKey: string;
  /** Per HTTP call. */
  timeoutMs: number;
  /** Supadata answers 202 with a job for slow transcripts; this bounds how long we poll it. */
  jobPollAttempts: number;
  jobPollIntervalMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Waits between job polls; tests pass an instant one. */
  sleep?: (ms: number) => Promise<unknown>;
}

const DEFAULT_BASE_URL = 'https://api.supadata.ai';

const errorBody = z.object({ error: z.string(), message: z.string().nullish() });

const transcriptBody = z.object({
  content: z.array(z.object({ text: z.string(), offset: z.number(), duration: z.number() })),
  lang: z.string().nullish(),
});

const jobAccepted = z.object({ jobId: z.string().min(1) });

const jobResult = z.object({
  status: z.enum(['queued', 'active', 'completed', 'failed']),
  error: z.unknown().optional(),
});

const metadataBody = z.object({
  title: z.string().nullish(),
  media: z.object({ duration: z.number().nullish() }).nullish(),
});

const messages = {
  unreachable: "We couldn't reach the transcript service. Please try again.",
  busy: 'The transcript service is busy right now. Please try again in a few minutes.',
  pending: 'The transcript is still being prepared. Please try again in a few minutes.',
  noTranscript: "This video has no captions, so there's no transcript to read.",
  unavailable: "This video couldn't be found. It may be private, removed or restricted.",
  invalid: "This link can't be read as a YouTube video.",
  failed: "We couldn't read this video. Please try again later.",
};

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/** Maps a Supadata error (its `error` identifier, else the HTTP status) to a classified failure. */
function failure(status: number, body: unknown): ExtractionError {
  const parsed = errorBody.safeParse(body);
  const id = parsed.success ? parsed.data.error : '';
  const detail = parsed.success ? (parsed.data.message ?? '') : 'no error body';
  const cause = new Error(`Supadata ${status}${id ? ` ${id}` : ''}: ${detail}`);

  if (id === 'transcript-unavailable') {
    return ExtractionError.permanent('NO_TRANSCRIPT', messages.noTranscript, { cause });
  }
  if (id === 'not-found' || id === 'forbidden' || status === 404 || status === 403) {
    return ExtractionError.permanent('VIDEO_UNAVAILABLE', messages.unavailable, { cause });
  }
  if (id === 'limit-exceeded' || status === 429) {
    return ExtractionError.transient(messages.busy, { cause });
  }
  if (id === 'internal-error' || status >= 500) {
    return ExtractionError.transient(messages.unreachable, { cause });
  }
  if (id === 'invalid-request' || status === 400) {
    return ExtractionError.permanent('EXTRACTION_FAILED', messages.invalid, { cause });
  }
  // `unauthorized` / `upgrade-required`: our key or plan. Retrying won't fix it; the cause is
  // logged for the owner.
  return ExtractionError.permanent('EXTRACTION_FAILED', messages.failed, { cause });
}

function unexpected(what: string, cause: unknown): ExtractionError {
  return ExtractionError.transient(messages.unreachable, {
    cause: new Error(`Supadata returned an unexpected ${what}`, { cause }),
  });
}

function toTranscript(body: unknown): Transcript {
  const parsed = transcriptBody.safeParse(body);
  if (!parsed.success) throw unexpected('transcript', parsed.error);

  const segments: TranscriptSegment[] = [];
  for (const { text, offset, duration } of parsed.data.content) {
    const trimmed = text.trim();
    if (trimmed === '') continue;
    // Supadata reports milliseconds.
    segments.push({
      text: trimmed,
      startSeconds: offset / 1000,
      endSeconds: (offset + duration) / 1000,
    });
  }
  if (segments.length === 0) {
    throw ExtractionError.permanent('NO_TRANSCRIPT', messages.noTranscript);
  }
  return { language: parsed.data.lang ?? null, segments };
}

export function createSupadataTranscriptProvider(config: SupadataConfig): TranscriptProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const sleep = config.sleep ?? ((ms: number) => delay(ms));

  /** GET, returning the HTTP status and JSON body. Supadata reports some errors with a 2xx. */
  async function get(path: string, query?: Record<string, string>) {
    const url = new URL(path, baseUrl);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);

    const response = await request(
      url,
      { headers: { 'x-api-key': config.apiKey } },
      {
        fetch: config.fetch ?? fetch,
        timeoutMs: config.timeoutMs,
        unreachableMessage: messages.unreachable,
      },
    );
    const body = await readJson(response);
    if (!response.ok || errorBody.safeParse(body).success) throw failure(response.status, body);
    return { status: response.status, body };
  }

  async function pollJob(jobId: string): Promise<Transcript> {
    for (let attempt = 0; attempt < config.jobPollAttempts; attempt++) {
      await sleep(config.jobPollIntervalMs);
      const { status, body } = await get(`/v1/transcript/${encodeURIComponent(jobId)}`);
      const job = jobResult.safeParse(body);
      if (!job.success) throw unexpected('job result', job.error);
      if (job.data.status === 'completed') return toTranscript(body);
      if (job.data.status === 'failed') throw failure(status, job.data.error);
    }
    throw ExtractionError.transient(messages.pending);
  }

  return {
    async getVideo(videoId) {
      const { body } = await get('/v1/metadata', { url: watchUrl(videoId) });
      const parsed = metadataBody.safeParse(body);
      if (!parsed.success) throw unexpected('video description', parsed.error);
      return {
        title: parsed.data.title?.trim() || null,
        durationSeconds: parsed.data.media?.duration ?? null,
      };
    },

    async getTranscript(videoId) {
      // `native` = the video's own captions only. Without it Supadata would generate a
      // transcript with AI for caption-less videos, which is slower and costs far more.
      const { status, body } = await get('/v1/transcript', {
        url: watchUrl(videoId),
        text: 'false',
        mode: 'native',
      });
      if (status === 202) {
        const job = jobAccepted.safeParse(body);
        if (!job.success) throw unexpected('job', job.error);
        return pollJob(job.data.jobId);
      }
      return toTranscript(body);
    },
  };
}
