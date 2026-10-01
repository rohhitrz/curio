import { readFile } from 'node:fs/promises';
import { chunking } from '../../apps/server/src/config/index.js';
import { createUnpdfParser } from '../../apps/server/src/lib/pdf/index.js';
import type { ScrapedPage } from '../../apps/server/src/lib/scraper/index.js';
import type { Transcript } from '../../apps/server/src/lib/transcript/index.js';
import { chunkContent, type Chunk } from '../../apps/server/src/pipelines/ingestion/chunk.js';
import type { ExtractedContent } from '../../apps/server/src/pipelines/ingestion/extract.js';
import { countTokens } from '../../apps/server/src/pipelines/ingestion/tokens.js';
import { cachePath, datasetDir, type EvalDocument } from './dataset.js';

/** What the fetch script caches for a YouTube document. */
export interface CachedVideo {
  videoId: string;
  video: { title: string | null; durationSeconds: number | null };
  transcript: Transcript;
}

const pdf = createUnpdfParser();

/** Reads a document from the cache (or the committed notes) as ingestion would extract it. */
export async function readContent(document: EvalDocument): Promise<ExtractedContent> {
  switch (document.type) {
    case 'PDF': {
      const { pages } = await pdf.parse(new Uint8Array(await readFile(cachePath(document))));
      return { kind: 'pages', pages };
    }
    case 'WEBSITE': {
      const page = JSON.parse(await readFile(cachePath(document), 'utf8')) as ScrapedPage;
      return { kind: 'markdown', markdown: page.markdown };
    }
    case 'YOUTUBE': {
      const cached = JSON.parse(await readFile(cachePath(document), 'utf8')) as CachedVideo;
      return { kind: 'transcript', segments: cached.transcript.segments };
    }
    case 'TEXT':
      return {
        kind: 'markdown',
        markdown: (await readFile(`${datasetDir}${document.file}`, 'utf8')).trim(),
      };
  }
}

/** The chunks ingestion would store for a document, with the app's own chunking config. */
export async function chunkDocument(
  document: EvalDocument,
  targetTokens: number = chunking.targetTokens,
): Promise<Chunk[]> {
  const content = await readContent(document);
  return chunkContent(content, { title: document.title, ...chunking, targetTokens, countTokens })
    .chunks;
}
