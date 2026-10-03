import type { ResourceRole } from '@curio/shared';
import { z } from 'zod';
import type { LlmProvider } from '../../lib/llm/index.js';
import type { MappedConcept } from './map.js';

/** One resource's concepts, as the map step found them. */
export interface MappedResource {
  /** `path_resources.id`. */
  resourceId: string;
  role: ResourceRole;
  title: string;
  concepts: MappedConcept[];
}

/** A concept of the path after merging, with the resources that cover it. */
export interface PathConcept {
  /** Stable within one job run: its position in the merged list. */
  key: number;
  name: string;
  description: string;
  /** `path_resources.id`s covering it; empty for a gap concept. */
  resourceIds: string[];
  /** 0–1 (see `consensusScore`). */
  score: number;
  /** Added by the order step as a missing prerequisite; no resource covers it. */
  gap: boolean;
}

/** Fixed for every merge call, so OpenAI caches it as the prompt prefix. */
export const CONCEPT_MERGE_INSTRUCTIONS = `You merge concept lists from several learning resources on one topic.

Each concept has an ID like "2.5" (resource 2, concept 5). Different resources often name the same concept differently ("Backprop", "Backpropagation algorithm"). Group the IDs that mean the same concept.

Rules:
- Only group concepts that are truly the same idea. A concept and a part of it ("Neural networks" and "Activation functions") stay separate.
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

/**
 * The weight of the resources covering a concept over the weight of all mapped resources
 * (decision L-01): 1 when every resource covers it. The official resource weighs more.
 */
export function consensusScore(
  covering: ResourceRole[],
  all: ResourceRole[],
  weights: { officialWeight: number; popularWeight: number },
): number {
  const weigh = (roles: ResourceRole[]) =>
    roles.reduce(
      (sum, role) => sum + (role === 'OFFICIAL' ? weights.officialWeight : weights.popularWeight),
      0,
    );
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
  weights: { officialWeight: number; popularWeight: number },
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
      resourceIds: covering.map((r) => r.resourceId),
      score: consensusScore(
        covering.map((r) => r.role),
        allRoles,
        weights,
      ),
      gap: false,
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
