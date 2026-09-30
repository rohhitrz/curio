/**
 * Writes `evals/.cache/review.md` for reviewing the golden dataset by hand: each question with
 * its expected answer and the text of every chunk at its expected locations, so each answer can
 * be checked against its source without opening the documents (no network, no LLM).
 *
 *   pnpm --filter @curio/evals review
 */
import { writeFile } from 'node:fs/promises';
import type { Chunk } from '../../apps/server/src/pipelines/ingestion/chunk.js';
import { chunkDocument } from '../src/content.js';
import { cacheDir, readDocuments } from '../src/dataset.js';
import { readQuestions, type ExpectedLocation } from '../src/questions.js';
import { matchesLocation } from '../src/relevance.js';

function describeLocation(location: ExpectedLocation): string {
  if ('pageNumber' in location) return `page ${String(location.pageNumber)}`;
  if ('startSeconds' in location) {
    return `${String(location.startSeconds)}s–${String(location.endSeconds)}s`;
  }
  return location.headingPath ?? '(before the first heading)';
}

/** Chunk text quoted in full as a markdown blockquote (chunks are ~500 tokens at most). */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

async function main() {
  const documents = await readDocuments();
  const titles = new Map(documents.map((d) => [d.id, d.title]));
  const chunksByDocument = new Map<string, Chunk[]>();
  for (const document of documents) {
    chunksByDocument.set(document.id, await chunkDocument(document));
  }

  const sections = (await readQuestions()).map((question) => {
    const lines = [`## ${question.id} · ${question.category}`, ''];
    for (const turn of question.history) {
      lines.push(`- _${turn.role}:_ ${turn.content}`);
    }
    if (question.history.length > 0) lines.push('');
    lines.push(`**Q:** ${question.question}`, '', `**Expected:** ${question.expectedAnswer}`, '');

    for (const location of question.expectedLocations) {
      const chunks = (chunksByDocument.get(location.documentId) ?? []).filter((chunk) =>
        matchesLocation({ documentId: location.documentId, ...chunk }, location),
      );
      const title = titles.get(location.documentId) ?? location.documentId;
      lines.push(`**Source:** ${title} · ${describeLocation(location)}`, '');
      for (const chunk of chunks) {
        lines.push(`_chunk #${String(chunk.chunkIndex)}_`, '', quote(chunk.content), '');
      }
    }
    return lines.join('\n');
  });

  const path = `${cacheDir}review.md`;
  await writeFile(path, `# Golden dataset review\n\n${sections.join('\n---\n\n')}`);
  console.log(`Wrote ${path}`);
}

await main();
