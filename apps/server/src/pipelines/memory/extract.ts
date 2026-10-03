import { z } from 'zod';
import { memoryExtraction } from '../../config/index.js';
import type { LlmMessage, LlmProvider } from '../../lib/llm/index.js';
import { stripMarkers } from '../retrieval/citations.js';

/** The kinds chat extraction may write; `LEVEL` and `UNDERSTOOD` come from direct events only. */
export const EXTRACTED_KINDS = ['STYLE', 'GOAL', 'FACT'] as const;
export type ExtractedKind = (typeof EXTRACTED_KINDS)[number];

/** Fixed for every call, so OpenAI caches it as the prompt prefix. */
export const MEMORY_EXTRACTION_INSTRUCTIONS = `You maintain a short list of facts about a learner, so a study assistant can adjust how it explains things. You read new messages from a conversation between the learner and the assistant.

Save only what the learner says about themselves:
- STYLE: how they like explanations (e.g. "prefers short answers with examples", "wants analogies, not formulas").
- GOAL: what they are working towards (e.g. "preparing for a statistics exam in June").
- FACT: background that changes how to teach them (e.g. "is a nurse", "knows Python", "is new to calculus", "prefers answers in Spanish").

Never save:
- Anything from the sources or the assistant's answers: definitions, explanations, facts about the subject. The learner asking about something is not a fact about them.
- Guesses. Only what the learner clearly states or plainly shows.
- Sensitive details (health, finances, relationships, contact details) unless the learner says they matter for learning.

Return JSON with "operations", a list (often empty). Each operation:
- "action": "add" for a new fact, or "update" when a new message changes or contradicts an existing memory (then "memoryId" is that memory's id and "content" the full new text). Never add a duplicate of an existing memory; if nothing changed, leave it out.
- "memoryId": the id for "update", otherwise null.
- "kind": STYLE, GOAL or FACT for "add", otherwise null.
- "scope": for "add", "TOPIC" when the fact is only about the notebook's topic (e.g. their background in it), "GLOBAL" when it holds everywhere (style, language, profession). Use "TOPIC" only when a topic is given. Otherwise null.
- "content": one short sentence in the third person ("Prefers worked examples."), at most 200 characters, in the language the learner writes in.

Memories marked "set by the learner" may not be updated.`;

export const memoryExtractionSchema = z.object({
  operations: z.array(
    z.object({
      action: z.enum(['add', 'update']),
      memoryId: z.string().nullable(),
      kind: z.enum(EXTRACTED_KINDS).nullable(),
      scope: z.enum(['GLOBAL', 'TOPIC']).nullable(),
      content: z.string(),
    }),
  ),
});
export type ExtractionOperation = z.infer<typeof memoryExtractionSchema>['operations'][number];

export interface ExistingMemory {
  id: string;
  scope: 'GLOBAL' | 'TOPIC';
  kind: ExtractedKind;
  content: string;
  /** `USER_EDITED`: shown to the model, never changed by it. */
  userEdited: boolean;
}

export interface ExtractionInput {
  /** The notebook's topic, if it has one. */
  topicName: string | null;
  existing: ExistingMemory[];
  /** The new messages, oldest first. */
  messages: LlmMessage[];
}

/** Topic, current memories and the new messages as one user message (read as data). */
export function buildExtractionMessage(input: ExtractionInput): LlmMessage {
  const memories =
    input.existing.length === 0
      ? '(none)'
      : input.existing
          .map(
            (m) =>
              `- id ${m.id} · ${m.scope} · ${m.kind}${m.userEdited ? ' · set by the learner' : ''}: ${m.content}`,
          )
          .join('\n');
  const transcript = input.messages
    .map((message) => {
      if (message.role === 'user') return `Learner: ${message.content}`;
      const answer = stripMarkers(message.content);
      const cut =
        answer.length > memoryExtraction.answerPromptMaxChars
          ? `${answer.slice(0, memoryExtraction.answerPromptMaxChars)}…`
          : answer;
      return `Assistant: ${cut}`;
    })
    .join('\n\n');
  return {
    role: 'user',
    content: `Notebook topic: ${input.topicName ?? '(none)'}\n\nCurrent memories:\n${memories}\n\n---\n\nNew messages:\n\n${transcript}`,
  };
}

/** One Luna call with structured output. Failures are `LlmError`s. */
export async function extractMemories(
  input: ExtractionInput,
  deps: { llm: LlmProvider },
): Promise<ExtractionOperation[]> {
  const { object } = await deps.llm.generateObject(
    {
      task: 'memoryExtraction',
      instructions: MEMORY_EXTRACTION_INSTRUCTIONS,
      messages: [buildExtractionMessage(input)],
    },
    memoryExtractionSchema,
  );
  return object.operations;
}

const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** True if `content` shares a run of `n` consecutive words with any of `texts`. */
export function sharesWordRun(content: string, texts: string[], n: number): boolean {
  const own = words(content);
  if (own.length < n) return false;
  const runs = new Set<string>();
  for (let i = 0; i + n <= own.length; i += 1) runs.add(own.slice(i, i + n).join(' '));
  return texts.some((text) => {
    const other = words(text);
    for (let i = 0; i + n <= other.length; i += 1) {
      if (runs.has(other.slice(i, i + n).join(' '))) return true;
    }
    return false;
  });
}

export type ScreenedOperation =
  | { action: 'add'; kind: ExtractedKind; scope: 'GLOBAL' | 'TOPIC'; content: string }
  | { action: 'update'; memoryId: string; content: string };

export type RejectReason =
  | 'empty'
  | 'too_long'
  | 'source_like'
  | 'unknown_memory'
  | 'user_edited'
  | 'missing_kind'
  | 'no_topic'
  | 'duplicate'
  | 'too_many';

/**
 * The deterministic check after the model (pure): only well-formed facts about the learner get
 * through. Drops anything that looks copied from an answer (and so from the sources), updates of
 * unknown or user-edited memories, topic facts without a topic, duplicates, and adds past
 * `maxNewPerRun`.
 */
export function screenOperations(
  operations: ExtractionOperation[],
  context: { existing: ExistingMemory[]; answers: string[]; hasTopic: boolean },
): { accepted: ScreenedOperation[]; rejected: { content: string; reason: RejectReason }[] } {
  const accepted: ScreenedOperation[] = [];
  const rejected: { content: string; reason: RejectReason }[] = [];
  const byId = new Map(context.existing.map((m) => [m.id, m]));
  const seen = new Set(context.existing.map((m) => m.content.trim().toLowerCase()));
  let adds = 0;

  for (const op of operations) {
    const content = op.content.replace(/\s+/g, ' ').trim();
    const reject = (reason: RejectReason) => rejected.push({ content, reason });
    if (content === '') {
      reject('empty');
      continue;
    }
    if (content.length > memoryExtraction.contentMaxChars) {
      reject('too_long');
      continue;
    }
    if (sharesWordRun(content, context.answers, memoryExtraction.sourceOverlapWords)) {
      reject('source_like');
      continue;
    }
    const key = content.toLowerCase();
    if (seen.has(key)) {
      reject('duplicate');
      continue;
    }

    if (op.action === 'update') {
      const target = op.memoryId === null ? undefined : byId.get(op.memoryId);
      if (!target) reject('unknown_memory');
      else if (target.userEdited) reject('user_edited');
      else {
        accepted.push({ action: 'update', memoryId: target.id, content });
        seen.add(key);
      }
      continue;
    }

    if (op.kind === null) {
      reject('missing_kind');
      continue;
    }
    const scope = op.scope ?? 'GLOBAL';
    if (scope === 'TOPIC' && !context.hasTopic) {
      reject('no_topic');
      continue;
    }
    if (adds >= memoryExtraction.maxNewPerRun) {
      reject('too_many');
      continue;
    }
    accepted.push({ action: 'add', kind: op.kind, scope, content });
    seen.add(key);
    adds += 1;
  }
  return { accepted, rejected };
}
