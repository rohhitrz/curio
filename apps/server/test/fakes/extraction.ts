import type { ParsedPdf, PdfParser } from '../../src/lib/pdf/index.js';
import type { ScrapedPage, ScraperProvider } from '../../src/lib/scraper/index.js';
import type { Transcript, TranscriptProvider, VideoInfo } from '../../src/lib/transcript/index.js';

/** Errors queued here are thrown by the next calls, one per call, before any result is returned. */
function failureQueue() {
  const queue: Error[] = [];
  return {
    push: (...errors: Error[]) => queue.push(...errors),
    throwNext() {
      const error = queue.shift();
      if (error) throw error;
    },
  };
}

/** `page` for every URL, except those in `byUrl` (a page, or an error that URL throws). */
export function createFakeScraper(
  page: ScrapedPage = { title: 'Example page', markdown: '# Example\n\nSome text.' },
  byUrl: Record<string, ScrapedPage | Error> = {},
) {
  const failures = failureQueue();
  const calls: string[] = [];
  const provider: ScraperProvider = {
    scrape(url) {
      calls.push(url);
      failures.throwNext();
      const own = byUrl[url];
      if (own instanceof Error) return Promise.reject(own);
      return Promise.resolve(own ?? page);
    },
  };
  return { provider, calls, failNext: failures.push };
}

export function createFakeTranscript(
  video: VideoInfo = { title: 'Example video', durationSeconds: 600 },
  transcript: Transcript = {
    language: 'en',
    segments: [
      { text: 'Hello.', startSeconds: 0, endSeconds: 2 },
      { text: 'Welcome.', startSeconds: 2, endSeconds: 5 },
    ],
  },
) {
  const failures = failureQueue();
  const calls: string[] = [];
  const provider: TranscriptProvider = {
    getVideo(videoId) {
      calls.push(`video:${videoId}`);
      failures.throwNext();
      return Promise.resolve(video);
    },
    getTranscript(videoId) {
      calls.push(`transcript:${videoId}`);
      failures.throwNext();
      return Promise.resolve(transcript);
    },
  };
  return { provider, calls, failNext: failures.push };
}

export function createFakePdfParser(
  parsed: ParsedPdf = { pages: [{ pageNumber: 1, text: 'Page one.' }] },
) {
  const failures = failureQueue();
  const calls: Uint8Array[] = [];
  const provider: PdfParser = {
    parse(file) {
      calls.push(file);
      failures.throwNext();
      return Promise.resolve(parsed);
    },
  };
  return { provider, calls, failNext: failures.push };
}
