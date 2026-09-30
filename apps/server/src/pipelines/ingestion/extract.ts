import { createHash } from 'node:crypto';
import { quotas } from '../../config/index.js';
import { ExtractionError } from '../../errors/extraction-error.js';
import type { PdfPage, PdfParser } from '../../lib/pdf/index.js';
import type { ScraperProvider } from '../../lib/scraper/index.js';
import type { StorageProvider } from '../../lib/storage/index.js';
import type { TranscriptProvider, TranscriptSegment } from '../../lib/transcript/index.js';

/** What was read, in the shape that keeps each type's citation location. */
export type ExtractedContent =
  /** PDF: text per page (location = page number). */
  | { kind: 'pages'; pages: PdfPage[] }
  /** YouTube: caption segments (location = start timestamp). */
  | { kind: 'transcript'; segments: TranscriptSegment[] }
  /** Website and pasted text: markdown (location = heading path / offset). */
  | { kind: 'markdown'; markdown: string };

export interface Extraction {
  /** The source's real title when extraction learned it; `null` keeps the current title. */
  title: string | null;
  content: ExtractedContent;
  /** Facts learned while reading, to merge into `sources.metadata`. */
  metadata: Record<string, unknown>;
}

/** The columns extraction needs from a source row. */
export interface ExtractableSource {
  type: 'PDF' | 'WEBSITE' | 'YOUTUBE' | 'TEXT';
  url: string | null;
  storageKey: string | null;
  extractedText: string | null;
  metadata: Record<string, unknown>;
}

export interface ExtractionDeps {
  storage: StorageProvider;
  pdf: PdfParser;
  scraper: ScraperProvider;
  transcript: TranscriptProvider;
}

const messages = {
  storageDown: "We couldn't load the uploaded file. Please try again.",
  fileMissing: 'The uploaded file is no longer available. Please upload it again.',
  noUrl: 'This source has no link to read.',
  notAVideo: "This link can't be read as a YouTube video.",
  emptyText: 'There is no text to read in this note.',
  tooLong: `Videos longer than ${quotas.youtubeMaxSeconds / 3600} hours aren't supported.`,
};

function assertVideoLength(durationSeconds: number | null): void {
  if (durationSeconds !== null && durationSeconds > quotas.youtubeMaxSeconds) {
    throw ExtractionError.permanent('VIDEO_TOO_LONG', messages.tooLong);
  }
}

async function extractPdf(source: ExtractableSource, deps: ExtractionDeps): Promise<Extraction> {
  const { storageKey } = source;
  if (storageKey === null) throw ExtractionError.permanent('FILE_MISSING', messages.fileMissing);

  let file: Uint8Array | null;
  try {
    file = await deps.storage.download(storageKey);
  } catch (cause) {
    throw ExtractionError.transient(messages.storageDown, { cause });
  }
  if (file === null) throw ExtractionError.permanent('FILE_MISSING', messages.fileMissing);

  const { pages } = await deps.pdf.parse(file);
  return {
    // A PDF keeps the title the user gave it.
    title: null,
    content: { kind: 'pages', pages },
    metadata: {
      pageCount: pages.length,
      // The hash the browser sent is only a claim; this is the file's real one.
      fileHash: createHash('sha256').update(file).digest('hex'),
    },
  };
}

async function extractWebsite(
  source: ExtractableSource,
  deps: ExtractionDeps,
): Promise<Extraction> {
  if (source.url === null) throw ExtractionError.permanent('EXTRACTION_FAILED', messages.noUrl);
  const page = await deps.scraper.scrape(source.url);
  return {
    title: page.title,
    content: { kind: 'markdown', markdown: page.markdown },
    metadata: {},
  };
}

async function extractYouTube(
  source: ExtractableSource,
  deps: ExtractionDeps,
): Promise<Extraction> {
  const { videoId } = source.metadata;
  if (typeof videoId !== 'string' || videoId === '') {
    throw ExtractionError.permanent('EXTRACTION_FAILED', messages.notAVideo);
  }

  // Length is checked before the transcript is fetched, so an over-long video costs one cheap call.
  const video = await deps.transcript.getVideo(videoId);
  assertVideoLength(video.durationSeconds);

  const { language, segments } = await deps.transcript.getTranscript(videoId);
  // When the vendor didn't report a length, the last caption's end is the best measure.
  const durationSeconds =
    video.durationSeconds ?? Math.ceil(segments[segments.length - 1]?.endSeconds ?? 0);
  assertVideoLength(durationSeconds);

  return {
    title: video.title,
    content: { kind: 'transcript', segments },
    metadata: { durationSeconds, ...(language !== null && { language }) },
  };
}

function extractText(source: ExtractableSource): Extraction {
  const markdown = source.extractedText?.trim() ?? '';
  if (markdown === '') throw ExtractionError.permanent('NO_TEXT', messages.emptyText);
  return { title: null, content: { kind: 'markdown', markdown }, metadata: {} };
}

/**
 * Reads a source into text plus the locations its citations need. Throws `ExtractionError`:
 * `retryable` ones are worth another attempt, the rest fail the source with their message.
 */
export async function extractSource(
  source: ExtractableSource,
  deps: ExtractionDeps,
): Promise<Extraction> {
  switch (source.type) {
    case 'PDF':
      return extractPdf(source, deps);
    case 'WEBSITE':
      return extractWebsite(source, deps);
    case 'YOUTUBE':
      return extractYouTube(source, deps);
    case 'TEXT':
      return extractText(source);
  }
}
