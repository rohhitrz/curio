/**
 * Validates the golden dataset against the cached documents (no network, no LLM):
 * - documents.json and questions.jsonl parse, IDs are unique, every documentId exists;
 * - every expected location matches at least one chunk that ingestion would produce,
 *   so a typo in a heading path or a wrong page is caught before it silently scores 0.
 *
 *   pnpm --filter @curio/evals check
 */
import type { Chunk } from '../../apps/server/src/pipelines/ingestion/chunk.js';
import { chunkDocument } from '../src/content.js';
import { readDocuments } from '../src/dataset.js';
import { categories, readQuestions } from '../src/questions.js';
import { matchesLocation } from '../src/relevance.js';

async function main() {
  const documents = await readDocuments();
  const questions = await readQuestions();

  const chunksByDocument = new Map<string, Chunk[]>();
  for (const document of documents) {
    chunksByDocument.set(document.id, await chunkDocument(document));
  }

  const problems: string[] = [];
  for (const question of questions) {
    for (const location of question.expectedLocations) {
      const chunks = chunksByDocument.get(location.documentId);
      if (!chunks) {
        problems.push(`${question.id}: unknown document ${location.documentId}`);
        continue;
      }
      const matching = chunks.filter((chunk) =>
        matchesLocation({ documentId: location.documentId, ...chunk }, location),
      );
      if (matching.length === 0) {
        problems.push(`${question.id}: no chunk matches ${JSON.stringify(location)}`);
      }
    }
  }

  const total = [...chunksByDocument.values()].reduce((sum, chunks) => sum + chunks.length, 0);
  console.log(`${String(documents.length)} documents, ${String(total)} chunks`);
  console.log(`${String(questions.length)} questions`);
  for (const category of categories) {
    const count = questions.filter((q) => q.category === category).length;
    console.log(`  ${category}: ${String(count)}`);
  }
  for (const document of documents) {
    const count = questions.filter((q) =>
      q.expectedLocations.some((l) => l.documentId === document.id),
    ).length;
    console.log(`  ${document.id}: ${String(count)} questions`);
  }

  if (problems.length > 0) {
    console.error(`\n${String(problems.length)} problem(s):\n${problems.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('\nEvery expected location matches at least one chunk.');
  }
}

await main();
