import type { ResourceRole } from '@curio/shared';
import { z } from 'zod';
import type { LlmProvider } from '../../lib/llm/index.js';
import type { MappedConcept } from './map.js';

/**
 * Who votes on a concept: a resource, or the model's own knowledge of the topic (decision L-09),
 * which counts towards the score but is never a resource.
 */
export type VoterRole = ResourceRole | 'MODEL';

export interface ConsensusWeights {
  officialWeight: number;
  popularWeight: number;
  modelWeight: number;
}

/** The `resourceId` of the model's own concept list: never saved as coverage. */
export const MODEL_KNOWLEDGE_ID = 'model-knowledge';

/** One resource's concepts, as the map step found them (or the model's own list, L-09). */
export interface MappedResource {
  /** `path_resources.id`, or `MODEL_KNOWLEDGE_ID`. */
  resourceId: string;
  role: VoterRole;
  title: string;
  concepts: MappedConcept[];
}

/** A concept of the path after merging, with the resources that cover it. */
export interface PathConcept {
  /** Stable within one job run: its position in the merged list. */
  key: number;
  name: string;
  description: string;
  /** `path_resources.id`s covering it; empty for a gap concept or one only the model listed. */
  resourceIds: string[];
  /** 0–1 (see `consensusScore`). */
  score: number;
  /** Added by the order step as a missing prerequisite; no resource covers it. */
  gap: boolean;
  /** The model listed it from its own knowledge too (L-09). */
  fromModel?: boolean;
}

/** Fixed for every merge call, so OpenAI caches it as the prompt prefix. */
export const CONCEPT_MERGE_INSTRUCTIONS = `You merge concept lists from several learning resources on one topic.

Each concept has an ID like "2.5" (resource 2, concept 5). Different resources often name the same concept differently ("Backprop", "Backpropagation algorithm"), and at different detail: one lists "Loops", another "For loops" and "Loop control". Group the IDs that would be taught as the same concept.

Rules:
- Group the same idea under different names.
- Group a concept with its kinds, forms and basic uses: "Loops" with "For loops", "While loops" and "Loop control"; "Lists" with "List methods" and "List slicing"; "Strings" with "String literals" and "String formatting".
- Keep apart a concept and a different idea it is built from or used with: "Neural networks" and "Activation functions" stay separate; so do "Functions" and "Modules".
- When unsure, keep them apart.
- Every ID goes in exactly one group; a concept found once is a group of one.
- For each group give the clearest common name (1–5 words) and a one-sentence description.
- Write in English.`;

export const conceptMergeSchema = z.object({
  groups: z.array(
    z.object({ name: z.string(), description: z.string(), members: z.array(z.string()) }),
  ),
});
export type MergeGroup = z.infer<typeof conceptMergeSchema>['groups'][number];

const memberId = (resource: number, concept: number) =>
  `${String(resource + 1)}.${String(concept + 1)}`;

export function buildMergeMessage(topic: string, resources: MappedResource[]): string {
  const lists = resources
    .map((r, i) => {
      const concepts = r.concepts
        .map((c, j) => `  ${memberId(i, j)} ${c.name}: ${c.description}`)
        .join('\n');
      return `Resource ${String(i + 1)}: ${r.title}\n${concepts}`;
    })
    .join('\n\n');
  return `Topic: ${topic}\n\n${lists}`;
}

const WEIGHT_OF: Record<VoterRole, keyof ConsensusWeights> = {
  OFFICIAL: 'officialWeight',
  POPULAR: 'popularWeight',
  MODEL: 'modelWeight',
};

/**
 * The weight of the voters covering a concept over the weight of all voters (decisions L-01,
 * L-09): 1 when every one covers it. The official resource weighs the most.
 */
export function consensusScore(
  covering: VoterRole[],
  all: VoterRole[],
  weights: ConsensusWeights,
): number {
  const weigh = (roles: VoterRole[]) =>
    roles.reduce((sum, role) => sum + weights[WEIGHT_OF[role]], 0);
  const total = weigh(all);
  return total === 0 ? 0 : Math.round((weigh(covering) / total) * 1000) / 1000;
}

/**
 * The model's groups, checked by code: unknown IDs are ignored, an ID claimed twice stays in its
 * first group, an ID left out becomes its own concept, empty groups are dropped. Each concept's
 * coverage is the distinct resources of its members; then it is scored.
 */
export function applyMerge(
  resources: MappedResource[],
  groups: MergeGroup[],
  weights: ConsensusWeights,
): PathConcept[] {
  const members = new Map<string, { resource: number; concept: MappedConcept }>();
  resources.forEach((r, i) => {
    r.concepts.forEach((concept, j) => members.set(memberId(i, j), { resource: i, concept }));
  });

  const claimed = new Set<string>();
  const merged: { name: string; description: string; resources: Set<number> }[] = [];
  for (const group of groups) {
    const ids = group.members.map((m) => m.trim()).filter((m) => members.has(m) && !claimed.has(m));
    if (ids.length === 0) continue;
    ids.forEach((id) => claimed.add(id));
    const first = members.get(ids[0] ?? '');
    merged.push({
      name: group.name.trim() || (first?.concept.name ?? ''),
      description: group.description.trim() || (first?.concept.description ?? ''),
      resources: new Set(ids.map((id) => members.get(id)?.resource ?? -1)),
    });
  }
  for (const [id, { resource, concept }] of members) {
    if (claimed.has(id)) continue;
    merged.push({ ...concept, resources: new Set([resource]) });
  }

  const allRoles = resources.map((r) => r.role);
  return merged.map((m, key) => {
    const covering = [...m.resources]
      .sort((a, b) => a - b)
      .flatMap((i) => {
        const r = resources[i];
        return r ? [r] : [];
      });
    return {
      key,
      name: m.name,
      description: m.description,
      resourceIds: covering.flatMap((r) => (r.role === 'MODEL' ? [] : [r.resourceId])),
      score: consensusScore(
        covering.map((r) => r.role),
        allRoles,
        weights,
      ),
      gap: false,
      fromModel: covering.some((r) => r.role === 'MODEL'),
    };
  });
}

/** One Luna call grouping same-meaning concepts. Failures are `LlmError`s. */
export async function mergeConcepts(
  topic: string,
  resources: MappedResource[],
  deps: { llm: LlmProvider },
): Promise<MergeGroup[]> {
  const { object } = await deps.llm.generateObject(
    {
      task: 'conceptMerge',
      instructions: CONCEPT_MERGE_INSTRUCTIONS,
      messages: [{ role: 'user', content: buildMergeMessage(topic, resources) }],
    },
    conceptMergeSchema,
  );
  return object.groups;
}
