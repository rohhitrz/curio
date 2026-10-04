import { levelSchema, type Goal, type Level } from '@curio/shared';
import { z } from 'zod';
import type { LlmProvider } from '../../lib/llm/index.js';
import type { PathConcept } from './merge.js';

/** Fixed for every order call, so OpenAI caches it as the prompt prefix. */
export const PATH_ORDER_INSTRUCTIONS = `You design the structure of a study path from a list of concepts.

You get the topic, the learner's level and goal, and numbered concepts with how many resources cover each. Do three things:

1. Order: put the concepts in prerequisite order (what must be understood first comes first).
2. Modules: group consecutive concepts into modules, as many as the topic's breadth needs (3–10): a narrow topic needs few, a broad one more. Never pad with filler modules and never cram unrelated ideas into one; split a large idea into focused modules instead. Every concept number goes in exactly one module, in order. Each module has:
   - title: short (2–6 words)
   - summary: one sentence on what it covers
   - why: one or two sentences on why it matters for the learner's goal and how it builds on the modules before it; concrete, not generic
   - difficulty: "BEGINNER", "INTERMEDIATE" or "ADVANCED", how demanding this module is within this path (early modules are usually easier)
3. Gaps: if an essential prerequisite is missing from the list, you may add it (at most 3 in total) inside the module where it belongs, with "concept": null and its own name and description. Do not add anything else.

Each module item is {"concept": number or null, "name", "description"}; for a listed concept repeat its name.

Branches: only when the level is advanced, propose 2–4 branches: directions to study in depth, each a name, a one-sentence description and the module numbers (1-based) it covers. Branches may share modules. For other levels return an empty list.

Write in English.`;

export const pathOrderSchema = z.object({
  modules: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      why: z.string(),
      difficulty: levelSchema,
      items: z.array(
        z.object({
          concept: z.number().int().nullable(),
          name: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
  branches: z.array(
    z.object({ name: z.string(), description: z.string(), modules: z.array(z.number().int()) }),
  ),
});
export type PathOrderOutput = z.infer<typeof pathOrderSchema>;

export interface OutlineModule {
  title: string;
  summary: string;
  /** Null for the catch-all module code adds, and in outlines from before Phase 9. */
  why: string | null;
  difficulty: Level | null;
  /** Concept keys in learning order. */
  conceptKeys: number[];
}

export interface OutlineBranch {
  name: string;
  description: string;
  /** Indexes into `modules`. */
  moduleIndexes: number[];
}

/** The full structure before the cut: every concept placed in a module. */
export interface Outline {
  concepts: PathConcept[];
  modules: OutlineModule[];
  branches: OutlineBranch[];
}

const LEVEL_NAMES: Record<Level, string> = {
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
};

export function buildOrderMessage(
  brief: { topic: string; level: Level; goal: Goal },
  concepts: PathConcept[],
  resourceCount: number,
): string {
  const list = concepts
    .map(
      (c) =>
        `${String(c.key + 1)}. ${c.name}: ${c.description} (covered by ${String(c.resourceIds.length)} of ${String(resourceCount)})`,
    )
    .join('\n');
  return `Topic: ${brief.topic}\nLevel: ${LEVEL_NAMES[brief.level]}\nGoal: ${brief.goal.toLowerCase()}\n\nConcepts:\n${list}`;
}

/** The model gave no usable module: worth another try. */
export class InvalidOutlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutlineError';
  }
}

/**
 * The model's structure, checked by code: unknown or repeated concept numbers are ignored, at
 * most `maxGapConcepts` gaps are added, concepts it left out go to a last module, empty modules
 * are dropped, and branches keep only real modules and need `minBranchConcepts` concepts.
 */
export function applyOrder(
  concepts: PathConcept[],
  output: PathOrderOutput,
  limits: { maxGapConcepts: number; minBranchConcepts: number },
): Outline {
  const all = [...concepts];
  const placed = new Set<number>();
  const moduleIndex = new Map<number, number>();
  const modules: OutlineModule[] = [];
  let gaps = 0;

  output.modules.forEach((module, i) => {
    const keys: number[] = [];
    for (const item of module.items) {
      if (item.concept === null) {
        const name = item.name.trim();
        if (gaps >= limits.maxGapConcepts || name === '') continue;
        gaps += 1;
        const key = all.length;
        all.push({
          key,
          name,
          description: item.description.trim(),
          resourceIds: [],
          score: 0,
          gap: true,
        });
        keys.push(key);
        continue;
      }
      const key = item.concept - 1;
      if (key < 0 || key >= concepts.length || placed.has(key)) continue;
      placed.add(key);
      keys.push(key);
    }
    if (keys.length === 0) return;
    moduleIndex.set(i + 1, modules.length);
    modules.push({
      title: module.title.trim(),
      summary: module.summary.trim(),
      why: module.why.trim() || null,
      difficulty: module.difficulty,
      conceptKeys: keys,
    });
  });

  if (modules.length === 0) throw new InvalidOutlineError('the outline has no usable module');
  const left = concepts.filter((c) => !placed.has(c.key)).map((c) => c.key);
  if (left.length > 0) {
    modules.push({
      title: 'More concepts',
      summary: 'Concepts the resources cover that the modules above leave out.',
      why: null,
      difficulty: null,
      conceptKeys: left,
    });
  }

  const names = new Set<string>();
  const branches: OutlineBranch[] = [];
  for (const branch of output.branches) {
    const name = branch.name.trim();
    const indexes = [
      ...new Set(
        branch.modules.flatMap((m) => {
          const index = moduleIndex.get(m);
          return index === undefined ? [] : [index];
        }),
      ),
    ].sort((a, b) => a - b);
    const size = indexes.reduce((n, i) => n + (modules[i]?.conceptKeys.length ?? 0), 0);
    if (name === '' || names.has(name.toLowerCase()) || size < limits.minBranchConcepts) continue;
    names.add(name.toLowerCase());
    branches.push({ name, description: branch.description.trim(), moduleIndexes: indexes });
  }

  return { concepts: all, modules, branches };
}

/** One Luna call: order, modules, gaps, branches. Failures are `LlmError`s. */
export async function orderConcepts(
  brief: { topic: string; level: Level; goal: Goal },
  concepts: PathConcept[],
  resourceCount: number,
  deps: { llm: LlmProvider },
): Promise<PathOrderOutput> {
  const { object } = await deps.llm.generateObject(
    {
      task: 'learningPath',
      instructions: PATH_ORDER_INSTRUCTIONS,
      messages: [{ role: 'user', content: buildOrderMessage(brief, concepts, resourceCount) }],
    },
    pathOrderSchema,
  );
  return object;
}
