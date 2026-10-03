import { pathHookSchema, type Level, type PathHook } from '@curio/shared';
import type { LlmProvider } from '../../lib/llm/index.js';

/** Fixed for every hook call, so OpenAI caches it as the prompt prefix. */
export const PATH_HOOK_INSTRUCTIONS = `You write the opening of a study path: four short parts that make the learner want to start.

You get the topic, the learner's level, the path's modules and the opening of its main resource.

- what: what the topic is, in 1–2 plain sentences.
- why: why it matters to someone learning it, 1–2 sentences.
- example: one concrete real-world example of it in use, 1–2 sentences.
- origin: where it came from, in at most 2 sentences.

Base the facts on the resource text where it covers them; never invent names, dates or numbers you are unsure of (leave them out instead). Match the learner's level. No markdown, no source numbers. Write in English.`;

export interface HookInput {
  topic: string;
  level: Level;
  moduleTitles: string[];
  resourceTitle: string;
  /** The main resource's opening, already cut to size. */
  resourceText: string;
}

/** One Luna call. Failures are `LlmError`s. */
export async function generateHook(
  input: HookInput,
  deps: { llm: LlmProvider },
): Promise<PathHook> {
  const modules = input.moduleTitles.map((t, i) => `${String(i + 1)}. ${t}`).join('\n');
  const { object } = await deps.llm.generateObject(
    {
      task: 'pathHook',
      instructions: PATH_HOOK_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Topic: ${input.topic}\nLevel: ${input.level.toLowerCase()}\n\nModules:\n${modules}\n\nMain resource: ${input.resourceTitle}\n\n${input.resourceText}`,
        },
      ],
    },
    pathHookSchema,
  );
  return {
    what: object.what.trim(),
    why: object.why.trim(),
    example: object.example.trim(),
    origin: object.origin.trim(),
  };
}
