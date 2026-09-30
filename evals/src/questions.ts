import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { datasetDir } from './dataset.js';

export const questionsFile = `${datasetDir}questions.jsonl`;

/** Test plan §6.1. Each category is aimed at one retrieval technique, for the ablation table. */
export const categories = [
  'factual',
  /** Needs more than one search (sub-queries). */
  'multi-part',
  /** Only makes sense with `history` (query rewrite). */
  'follow-up',
  /** Hinges on a code, number or name (keyword search). */
  'exact-term',
  /** Not in any document: the right answer is a refusal. */
  'unanswerable',
] as const;

/**
 * Where an answer lives (test plan §6.2). Relevance is judged by location, not chunk ID, so
 * results stay comparable when chunking changes. One shape per source type:
 * - PDF: the page.
 * - YouTube: a time window around where it is said; a chunk overlapping it counts.
 * - Website / text: the chunk's full heading path, exactly as ingestion writes it
 *   (`null` = the part before the first heading).
 */
export const locationSchema = z.union([
  z.strictObject({ documentId: z.string(), pageNumber: z.int().positive() }),
  z
    .strictObject({
      documentId: z.string(),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().positive(),
    })
    .refine((l) => l.endSeconds > l.startSeconds, 'endSeconds must be after startSeconds'),
  z.strictObject({ documentId: z.string(), headingPath: z.string().min(1).nullable() }),
]);

export type ExpectedLocation = z.infer<typeof locationSchema>;

export const questionSchema = z
  .strictObject({
    id: z.string().regex(/^q-\d{3}$/),
    category: z.enum(categories),
    answerable: z.boolean(),
    /** Earlier turns, for follow-ups. */
    history: z.array(
      z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }),
    ),
    question: z.string().min(1),
    /** What a correct answer says; for unanswerable questions, why it isn't in the documents. */
    expectedAnswer: z.string().min(1),
    expectedLocations: z.array(locationSchema),
  })
  .refine((q) => q.answerable === (q.category !== 'unanswerable'), {
    message: 'answerable must be false exactly for the unanswerable category',
  })
  .refine((q) => q.answerable === q.expectedLocations.length > 0, {
    message: 'answerable questions need expectedLocations; unanswerable ones have none',
  })
  .refine((q) => (q.category === 'follow-up') === q.history.length > 0, {
    message: 'follow-up questions (and only those) have history',
  });

export type Question = z.infer<typeof questionSchema>;

/** Reads `questions.jsonl`: one question per line, blank lines ignored. */
export async function readQuestions(): Promise<Question[]> {
  const lines = (await readFile(questionsFile, 'utf8')).split('\n');
  const questions: Question[] = [];
  const ids = new Set<string>();
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const parsed = questionSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`questions.jsonl line ${String(index + 1)}: ${parsed.error.message}`);
    }
    if (ids.has(parsed.data.id)) throw new Error(`Duplicate question id ${parsed.data.id}`);
    ids.add(parsed.data.id);
    questions.push(parsed.data);
  });
  return questions;
}
