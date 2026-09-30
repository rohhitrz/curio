/**
 * Fetches the eval documents into the gitignored cache (`evals/.cache/`), using the app's own
 * Firecrawl and Supadata providers so the cache holds exactly what ingestion would read.
 *
 *   pnpm --filter @curio/evals fetch-docs            fetch what's missing, check hashes
 *   pnpm --filter @curio/evals fetch-docs --refresh  fetch everything again
 *
 * A document without `sha256` in documents.json gets the hash of what was fetched. A document
 * whose cached content no longer matches its hash fails the run: the upstream page or video
 * changed, and questions pointing into it need checking before the hash is updated by hand.
 *
 * Calls Firecrawl and Supadata (a few credits); never an LLM.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extraction } from '../../apps/server/src/config/index.js';
import { createFirecrawlScraper } from '../../apps/server/src/lib/scraper/index.js';
import { createSupadataTranscriptProvider } from '../../apps/server/src/lib/transcript/index.js';
import { parseYouTubeVideoId } from '../../apps/server/src/services/source-identity.js';
import {
  cacheDir,
  cachePath,
  documentsFile,
  readDocuments,
  sha256,
  type FetchedDocument,
} from '../src/dataset.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const scraper = createFirecrawlScraper({
  apiKey: requireEnv('FIRECRAWL_API_KEY'),
  timeoutMs: extraction.scrapeTimeoutMs,
});
const transcripts = createSupadataTranscriptProvider({
  apiKey: requireEnv('TRANSCRIPT_API_KEY'),
  timeoutMs: extraction.transcriptTimeoutMs,
  jobPollAttempts: extraction.transcriptJobPollAttempts,
  jobPollIntervalMs: extraction.transcriptJobPollIntervalMs,
});

async function download(document: FetchedDocument): Promise<Uint8Array | string> {
  switch (document.type) {
    case 'PDF': {
      const response = await fetch(document.url);
      if (!response.ok) throw new Error(`${document.url} answered ${String(response.status)}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    case 'WEBSITE':
      return `${JSON.stringify(await scraper.scrape(document.url), null, 2)}\n`;
    case 'YOUTUBE': {
      const videoId = parseYouTubeVideoId(document.url);
      if (videoId === null) throw new Error(`${document.url} is not a YouTube video URL`);
      const video = await transcripts.getVideo(videoId);
      const transcript = await transcripts.getTranscript(videoId);
      return `${JSON.stringify({ videoId, video, transcript }, null, 2)}\n`;
    }
  }
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const documents = await readDocuments();
  await mkdir(cacheDir, { recursive: true });

  const problems: string[] = [];
  let hashesAdded = false;

  for (const document of documents) {
    if (document.type === 'TEXT') continue;
    const path = cachePath(document);

    if (refresh || !(await exists(path))) {
      process.stdout.write(`fetching ${document.id} … `);
      await writeFile(path, await download(document));
      process.stdout.write('done\n');
    }

    const hash = sha256(await readFile(path));
    if (document.sha256 === undefined) {
      document.sha256 = hash;
      hashesAdded = true;
      console.log(`${document.id}: recorded sha256 ${hash.slice(0, 12)}…`);
    } else if (document.sha256 !== hash) {
      problems.push(
        `${document.id}: cached content changed (expected ${document.sha256.slice(0, 12)}…, ` +
          `got ${hash.slice(0, 12)}…). Check its questions, then update the hash.`,
      );
    } else {
      console.log(`${document.id}: ok`);
    }
  }

  if (hashesAdded) {
    await writeFile(documentsFile, `${JSON.stringify(documents, null, 2)}\n`);
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

await main();
