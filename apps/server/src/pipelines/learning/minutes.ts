import type { Level } from '@curio/shared';

/**
 * A module's estimated study time (L-11): its included concepts × minutes per concept for the
 * path's level, rounded up to 5. Computed from what the cut kept, so it matches what is taught.
 */
export function moduleMinutes(
  conceptCount: number,
  level: Level,
  minutesPerConcept: Record<Level, number>,
): number {
  if (conceptCount <= 0) return 0;
  return Math.ceil((conceptCount * minutesPerConcept[level]) / 5) * 5;
}
