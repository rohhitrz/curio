import type { Level } from '@curio/shared';
import type { PathConcept } from './merge.js';
import type { Outline, OutlineModule } from './order.js';

export interface CutRules {
  beginnerMinScore: number;
  intermediateMinScore: number;
  /** Fewer kept → the best-covered skipped ones are added back, up to this many. */
  beginnerMinConcepts: number;
  intermediateMinConcepts: number;
}

export interface CutPath {
  /** In order; only included concepts; modules left empty are dropped. */
  modules: OutlineModule[];
  /** Every concept not kept, with why (shown as "Skipped for now"). */
  skipped: { key: number; reason: string }[];
}

/**
 * The cut rules (docs/02-system-design.md §8, step 6; decision L-02): code decides what a path
 * keeps, from the consensus scores.
 * - Beginner: high consensus (`beginnerMinScore`) · intermediate: high + medium.
 * - Advanced: only the modules of the chosen branch, in depth. No branch (none was offered) →
 *   cut like intermediate.
 * - A gap concept (a prerequisite no resource covers) is kept when its module keeps something.
 * Same inputs → same path.
 */
export function cutPath(
  outline: Outline,
  level: Level,
  branchName: string | null,
  resourceCount: number,
  rules: CutRules,
): CutPath {
  const byKey = new Map(outline.concepts.map((c) => [c.key, c]));
  const branch =
    level === 'ADVANCED' && branchName !== null
      ? outline.branches.find((b) => b.name === branchName)
      : undefined;

  const kept = new Set<number>();
  // Place in the path (prerequisite order): earlier = more basic.
  const position = new Map(outline.modules.flatMap((m) => m.conceptKeys).map((key, i) => [key, i]));
  const placeOf = (key: number) => position.get(key) ?? Number.MAX_SAFE_INTEGER;
  let reasonFor: (c: PathConcept) => string;

  if (branch) {
    for (const index of branch.moduleIndexes) {
      for (const key of outline.modules[index]?.conceptKeys ?? []) kept.add(key);
    }
    reasonFor = () => 'Not in the branch you picked';
  } else {
    const beginner = level === 'BEGINNER';
    const minScore = beginner ? rules.beginnerMinScore : rules.intermediateMinScore;
    const minConcepts = beginner ? rules.beginnerMinConcepts : rules.intermediateMinConcepts;
    const covered = outline.concepts.filter((c) => !c.gap);
    for (const c of covered) if (c.score >= minScore) kept.add(c.key);
    // Too few pass: the best-covered of the rest are added back (score, then the earliest in
    // the path).
    const rest = covered
      .filter((c) => !kept.has(c.key))
      .sort((a, b) => b.score - a.score || placeOf(a.key) - placeOf(b.key) || a.key - b.key);
    for (const c of rest) {
      if (kept.size >= minConcepts) break;
      kept.add(c.key);
    }
    const suffix = beginner ? 'beyond the basics' : 'advanced';
    reasonFor = (c) =>
      c.resourceIds.length === 0
        ? `Not in the resources (general knowledge only), ${suffix}`
        : `Covered by ${String(c.resourceIds.length)} of ${String(resourceCount)} resources, ${suffix}`;
    // A gap concept stays with its module's kept concepts.
    for (const module of outline.modules) {
      if (!module.conceptKeys.some((key) => kept.has(key) && !byKey.get(key)?.gap)) continue;
      for (const key of module.conceptKeys) if (byKey.get(key)?.gap) kept.add(key);
    }
  }

  const modules = outline.modules
    .map((m) => ({ ...m, conceptKeys: m.conceptKeys.filter((key) => kept.has(key)) }))
    .filter((m) => m.conceptKeys.length > 0);
  const order = outline.modules.flatMap((m) => m.conceptKeys);
  const skipped = order
    .filter((key) => !kept.has(key))
    .flatMap((key) => {
      const c = byKey.get(key);
      if (!c) return [];
      return [
        {
          key,
          reason: c.gap && !branch ? 'A prerequisite none of the resources cover' : reasonFor(c),
        },
      ];
    });
  return { modules, skipped };
}
