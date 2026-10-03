import type { Level } from '@curio/shared';
import { z } from 'zod';
import type { LlmProvider } from '../../lib/llm/index.js';

/** Fixed for every map call, so OpenAI caches it as the prompt prefix. */
export const CONCEPT_MAP_INSTRUCTIONS = `You list the concepts a learning resource teaches, for building a study path on a topic.

You get the topic and the text of one resource (it may be cut off). List the distinct concepts this text actually explains, in the order it presents them.

Rules:
- Only concepts the text explains, not ones it merely mentions. Nothing from your own knowledge.
- A concept is a teachable idea, technique or fact about the topic ("Gradient descent", "Overfitting"), not a section title like "Introduction" or "Next steps", and not the topic itself.
- name: 1–5 words, the usual name of the concept. description: one sentence on what it is.
- At most the number of concepts asked for; prefer the most important.
- Write in English.`;

export const conceptMapSchema = z.object({
  concepts: z.array(z.object({ name: z.string(), description: z.string() })),
});
export type MappedConcept = z.infer<typeof conceptMapSchema>['concepts'][number];

/**
 * A resource's text cut to `maxChars` so every part gets a fair share: the text is split before
 * each top-level heading (`# `; a section's pages, L-08), each part gets an equal share, and what
 * short parts leave goes to the longer ones. Text within the budget is returned as it is.
 */
export function fairShare(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const parts = text.split(/\n(?=# )/);
  const allowed = new Map<number, number>();
  let left = maxChars - (parts.length - 1);
  // Shortest first: each takes its length or an equal share of what is left, whichever is less.
  const order = parts
    .map((part, i) => i)
    .sort((a, b) => (parts[a]?.length ?? 0) - (parts[b]?.length ?? 0));
  order.forEach((index, n) => {
    const share = Math.max(0, Math.floor(left / (order.length - n)));
    const take = Math.min(parts[index]?.length ?? 0, share);
    allowed.set(index, take);
    left -= take;
  });
  return parts
    .map((part, i) => part.slice(0, allowed.get(i) ?? 0))
    .filter((part) => part !== '')
    .join('\n');
}

export interface MapInput {
  topic: string;
  level: Level;
  title: string;
  text: string;
  maxConcepts: number;
}

/** Concepts one resource covers (one Luna call). Failures are `LlmError`s. */
export async function mapResource(
  input: MapInput,
  deps: { llm: LlmProvider },
): Promise<MappedConcept[]> {
  const { object } = await deps.llm.generateObject(
    {
      task: 'conceptMap',
      instructions: CONCEPT_MAP_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Topic: ${input.topic}\nList at most ${String(input.maxConcepts)} concepts.\n\nResource: ${input.title}\n\n${input.text}`,
        },
      ],
    },
    conceptMapSchema,
  );
  return cleanConcepts(object.concepts, input.maxConcepts);
}

/** Trimmed, no empty names, each name once (case-insensitive), at most `max`. */
function cleanConcepts(concepts: MappedConcept[], max: number): MappedConcept[] {
  const seen = new Set<string>();
  return concepts
    .map((c) => ({ name: c.name.trim(), description: c.description.trim() }))
    .filter((c) => {
      const key = c.name.toLowerCase();
      if (c.name === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

/** Fixed for every recall call, so OpenAI caches it as the prompt prefix. */
export const CONCEPT_RECALL_INSTRUCTIONS = `You list the core concepts of a topic from your own knowledge, for building a study path.

You get the topic and the learner's level. List the concepts a good course on this topic teaches a learner at that level, in teaching order.

Rules:
- Only well-established concepts that standard courses and the official documentation teach. Nothing obscure, nothing you are unsure of.
- A concept is a teachable idea, technique or fact about the topic ("Gradient descent", "Overfitting"), not a section title like "Introduction" or "Next steps", and not the topic itself.
- name: 1–5 words, the usual name of the concept. description: one sentence on what it is.
- At most the number of concepts asked for; prefer the most important.
- Write in English.`;

const LEVEL_FOR_RECALL: Record<Level, string> = {
  BEGINNER: 'a beginner (the fundamentals)',
  INTERMEDIATE: 'an intermediate learner (the fundamentals and what builds on them)',
  ADVANCED: 'an advanced learner (in depth)',
};

/**
 * The topic's core concepts from the model's own knowledge (decision L-09): one more voter in the
 * consensus, never a source. Same shape and clean-up as a mapped resource.
 */
export async function recallConcepts(
  input: { topic: string; level: Level; maxConcepts: number },
  deps: { llm: LlmProvider },
): Promise<MappedConcept[]> {
  const { object } = await deps.llm.generateObject(
    {
      task: 'conceptRecall',
      instructions: CONCEPT_RECALL_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Topic: ${input.topic}\nLearner: ${LEVEL_FOR_RECALL[input.level]}\nList at most ${String(input.maxConcepts)} concepts.`,
        },
      ],
    },
    conceptMapSchema,
  );
  return cleanConcepts(object.concepts, input.maxConcepts);
}
