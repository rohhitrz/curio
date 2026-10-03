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
  const seen = new Set<string>();
  return object.concepts
    .map((c) => ({ name: c.name.trim(), description: c.description.trim() }))
    .filter((c) => {
      const key = c.name.toLowerCase();
      if (c.name === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, input.maxConcepts);
}
