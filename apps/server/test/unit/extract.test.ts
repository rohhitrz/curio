import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createFakePdfParser,
  createFakeScraper,
  createFakeTranscript,
} from '../fakes/extraction.js';
import { createFakeStorage } from '../fakes/storage.js';
import { buildPdf } from '../helpers/pdf.js';
import { quotas } from '../../src/config/index.js';
import { IngestionError } from '../../src/errors/ingestion-error.js';
import { createUnpdfParser } from '../../src/lib/pdf/index.js';
import {
  extractSource,
  type ExtractableSource,
  type ExtractionDeps,
} from '../../src/pipelines/ingestion/extract.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'users/u1/uploads/file.pdf';

let storage: ReturnType<typeof createFakeStorage>;
let pdf: ReturnType<typeof createFakePdfParser>;
let scraper: ReturnType<typeof createFakeScraper>;
let transcript: ReturnType<typeof createFakeTranscript>;
let deps: ExtractionDeps;

function useFakes(overrides: Partial<ExtractionDeps> = {}) {
  deps = {
    storage: storage.provider,
    pdf: pdf.provider,
    scraper: scraper.provider,
    transcript: transcript.provider,
    ...overrides,
  };
}

function source(fields: Partial<ExtractableSource> & Pick<ExtractableSource, 'type'>) {
  return { url: null, storageKey: null, extractedText: null, metadata: {}, ...fields };
}

const website = source({ type: 'WEBSITE', url: 'https://www.example.com/a?utm_source=x' });
const youtube = source({
  type: 'YOUTUBE',
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  metadata: { videoId: VIDEO_ID },
});
const pdfSource = source({ type: 'PDF', storageKey: STORAGE_KEY, metadata: { fileSize: 10 } });

async function failure(input: ExtractableSource): Promise<IngestionError> {
  const error = await extractSource(input, deps).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IngestionError);
  return error as IngestionError;
}

beforeEach(() => {
  storage = createFakeStorage();
  pdf = createFakePdfParser();
  scraper = createFakeScraper();
  transcript = createFakeTranscript();
  useFakes();
});

describe('extract: PDF', () => {
  it('downloads the file and returns its pages, page count and real hash', async () => {
    const file = buildPdf(['First page.', 'Second page.']);
    storage.putFile(STORAGE_KEY, file);
    useFakes({ pdf: createUnpdfParser() });

    const result = await extractSource(pdfSource, deps);

    expect(result).toEqual({
      title: null,
      content: {
        kind: 'pages',
        pages: [
          { pageNumber: 1, text: 'First page.' },
          { pageNumber: 2, text: 'Second page.' },
        ],
      },
      metadata: { pageCount: 2, fileHash: createHash('sha256').update(file).digest('hex') },
    });
  });

  it('scanned PDF → permanent NO_TEXT', async () => {
    storage.putFile(STORAGE_KEY, buildPdf(['', '']));
    useFakes({ pdf: createUnpdfParser() });

    expect(await failure(pdfSource)).toMatchObject({ code: 'NO_TEXT', retryable: false });
  });

  it('file gone from storage → permanent FILE_MISSING, parser not called', async () => {
    const error = await failure(pdfSource);

    expect(error).toMatchObject({ code: 'FILE_MISSING', retryable: false });
    expect(error.message).toContain('upload it again');
    expect(pdf.calls).toEqual([]);
  });

  it('storage down → transient, with the cause kept', async () => {
    storage.putFile(STORAGE_KEY, buildPdf(['Text.']));
    const down = new Error('R2 is down');
    storage.failNextCall(down);

    const error = await failure(pdfSource);

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(error.cause).toBe(down);
  });
});

describe('extract: website', () => {
  it('scrapes the stored URL and returns markdown with the page title', async () => {
    const result = await extractSource(website, deps);

    expect(result).toEqual({
      title: 'Example page',
      content: { kind: 'markdown', markdown: '# Example\n\nSome text.' },
      metadata: {},
    });
    // The user's own URL, not the normalized one used for dedupe.
    expect(scraper.calls).toEqual(['https://www.example.com/a?utm_source=x']);
  });

  it('passes the scraper’s classified failure through', async () => {
    scraper.failNext(IngestionError.permanent('PAGE_NOT_FOUND', 'This page does not exist.'));

    expect(await failure(website)).toMatchObject({ code: 'PAGE_NOT_FOUND', retryable: false });
  });

  it('times out twice, then works', async () => {
    scraper.failNext(IngestionError.transient('slow'), IngestionError.transient('slow'));

    expect(await failure(website)).toMatchObject({ retryable: true });
    expect(await failure(website)).toMatchObject({ retryable: true });
    expect((await extractSource(website, deps)).content.kind).toBe('markdown');
  });
});

describe('extract: YouTube', () => {
  it('returns the transcript segments, the real title, length and language', async () => {
    const result = await extractSource(youtube, deps);

    expect(result).toEqual({
      title: 'Example video',
      content: {
        kind: 'transcript',
        segments: [
          { text: 'Hello.', startSeconds: 0, endSeconds: 2 },
          { text: 'Welcome.', startSeconds: 2, endSeconds: 5 },
        ],
      },
      metadata: { durationSeconds: 600, language: 'en' },
    });
    expect(transcript.calls).toEqual([`video:${VIDEO_ID}`, `transcript:${VIDEO_ID}`]);
  });

  it('video longer than 3 hours → permanent VIDEO_TOO_LONG before fetching the transcript', async () => {
    transcript = createFakeTranscript({
      title: 'Long stream',
      durationSeconds: quotas.youtubeMaxSeconds + 1,
    });
    useFakes();

    const error = await failure(youtube);

    expect(error).toMatchObject({ code: 'VIDEO_TOO_LONG', retryable: false });
    expect(error.message).toBe("Videos longer than 3 hours aren't supported.");
    expect(transcript.calls).toEqual([`video:${VIDEO_ID}`]);
  });

  it('exactly 3 hours is allowed', async () => {
    transcript = createFakeTranscript({ title: 'T', durationSeconds: quotas.youtubeMaxSeconds });
    useFakes();

    expect((await extractSource(youtube, deps)).content.kind).toBe('transcript');
  });

  it('length unknown → measured from the last caption', async () => {
    transcript = createFakeTranscript(
      { title: null, durationSeconds: null },
      { language: null, segments: [{ text: 'Hi.', startSeconds: 10, endSeconds: 61.4 }] },
    );
    useFakes();

    const result = await extractSource(youtube, deps);

    expect(result.title).toBeNull();
    expect(result.metadata).toEqual({ durationSeconds: 62 });
  });

  it('length unknown and captions run past 3 hours → permanent VIDEO_TOO_LONG', async () => {
    transcript = createFakeTranscript(
      { title: null, durationSeconds: null },
      {
        language: 'en',
        segments: [{ text: 'End.', startSeconds: 0, endSeconds: quotas.youtubeMaxSeconds + 30 }],
      },
    );
    useFakes();

    expect(await failure(youtube)).toMatchObject({ code: 'VIDEO_TOO_LONG', retryable: false });
  });

  it('no transcript → the provider’s permanent failure passes through', async () => {
    transcript.failNext(
      // The first queued failure hits `getVideo`; NO_TRANSCRIPT comes from either call.
      IngestionError.permanent('NO_TRANSCRIPT', 'This video has no captions.'),
    );

    expect(await failure(youtube)).toMatchObject({ code: 'NO_TRANSCRIPT', retryable: false });
  });

  it('source without a video ID → permanent PROCESSING_FAILED, no provider call', async () => {
    const error = await failure({ ...youtube, metadata: {} });

    expect(error).toMatchObject({ code: 'PROCESSING_FAILED', retryable: false });
    expect(transcript.calls).toEqual([]);
  });
});

describe('extract: text', () => {
  it('returns the stored text as markdown, trimmed, with no provider calls', async () => {
    const result = await extractSource(
      source({ type: 'TEXT', extractedText: '\n# Notes\n\nRegularization.\n' }),
      deps,
    );

    expect(result).toEqual({
      title: null,
      content: { kind: 'markdown', markdown: '# Notes\n\nRegularization.' },
      metadata: {},
    });
    expect(scraper.calls).toEqual([]);
    expect(transcript.calls).toEqual([]);
  });

  it.each([null, '', '  \n '])('empty text (%j) → permanent NO_TEXT', async (extractedText) => {
    expect(await failure(source({ type: 'TEXT', extractedText }))).toMatchObject({
      code: 'NO_TEXT',
      retryable: false,
    });
  });
});
