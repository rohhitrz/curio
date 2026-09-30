/**
 * Writes one markdown file per eval document to `evals/.cache/preview/`: each chunk ingestion
 * would produce, with its index, location and text (no network). Used to write questions whose
 * `expectedLocations` match what ingestion actually produces.
 *
 *   pnpm --filter @curio/evals preview
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type { Chunk } from '../../apps/server/src/pipelines/ingestion/chunk.js';
import { chunkDocument } from '../src/content.js';
import { cacheDir, readDocuments } from '../src/dataset.js';

function location(chunk: Chunk): string {
  if (chunk.pageNumber !== null) return `page ${String(chunk.pageNumber)}`;
  if (chunk.startSeconds !== null) {
    return `${String(chunk.startSeconds)}s–${String(chunk.endSeconds)}s`;
  }
  return chunk.headingPath ?? '(before the first heading)';
}

async function main() {
  const outDir = `${cacheDir}preview/`;
  await mkdir(outDir, { recursive: true });

  for (const document of await readDocuments()) {
    const chunks = await chunkDocument(document);
    const body = chunks
      .map(
        (chunk) =>
          `## #${String(chunk.chunkIndex)} · ${location(chunk)} · ${String(chunk.tokenCount)} tokens\n\n` +
          `${chunk.content}\n`,
      )
      .join('\n');
    await writeFile(`${outDir}${document.id}.md`, `# ${document.title}\n\n${body}`);
    console.log(`${document.id}: ${String(chunks.length)} chunks`);
  }
}

await main();
