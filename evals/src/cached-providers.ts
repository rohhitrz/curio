import { readFile } from 'node:fs/promises';
import type { ScrapedPage, ScraperProvider } from '../../apps/server/src/lib/scraper/index.js';
import type { StorageProvider } from '../../apps/server/src/lib/storage/index.js';
import type { TranscriptProvider } from '../../apps/server/src/lib/transcript/index.js';
import type { CachedVideo } from './content.js';
import { cachePath, type FetchedDocument } from './dataset.js';

/**
 * Providers that serve the eval documents from the local cache instead of R2, Firecrawl and
 * Supadata. Ingestion runs unchanged on top of them, so the eval measures the real pipeline on
 * content that can't drift between runs.
 */
export function createCachedProviders(documents: FetchedDocument[]) {
  const byUrl = new Map(documents.map((d) => [d.url, d]));
  const pdfByKey = new Map<string, FetchedDocument>();
  const videos = new Map<string, CachedVideo>();

  const missing = (what: string): never => {
    throw new Error(
      `Not in the eval cache: ${what}. Run \`pnpm --filter @curio/evals fetch-docs\`.`,
    );
  };

  async function loadVideo(videoId: string): Promise<CachedVideo> {
    const loaded = videos.get(videoId);
    if (loaded) return loaded;
    for (const document of documents) {
      if (document.type !== 'YOUTUBE') continue;
      const cached = JSON.parse(await readFile(cachePath(document), 'utf8')) as CachedVideo;
      videos.set(cached.videoId, cached);
    }
    return videos.get(videoId) ?? missing(`video ${videoId}`);
  }

  const unsupported = () => Promise.reject(new Error('Not available in evals'));

  const storage: StorageProvider = {
    createUploadUrl: unsupported,
    createDownloadUrl: unsupported,
    head: unsupported,
    async download(key) {
      const document = pdfByKey.get(key);
      return document ? new Uint8Array(await readFile(cachePath(document))) : null;
    },
    delete: () => Promise.resolve(),
  };

  const scraper: ScraperProvider = {
    async scrape(url) {
      const document = byUrl.get(url) ?? missing(url);
      return JSON.parse(await readFile(cachePath(document), 'utf8')) as ScrapedPage;
    },
  };

  const transcript: TranscriptProvider = {
    async getVideo(videoId) {
      return (await loadVideo(videoId)).video;
    },
    async getTranscript(videoId) {
      return (await loadVideo(videoId)).transcript;
    },
  };

  return {
    storage,
    scraper,
    transcript,
    /** Makes a PDF document downloadable under the storage key its source row uses. */
    registerPdf(key: string, document: FetchedDocument) {
      pdfByKey.set(key, document);
    },
  };
}
