import type {
  Goal,
  LearningPath,
  Level,
  Outline,
  OutlineModule,
  PathStatus,
  PrefillResponse,
} from '@curio/shared';

export const LEVEL_OPTIONS: { value: Level; label: string; hint: string }[] = [
  { value: 'BEGINNER', label: 'Beginner', hint: 'New to it: the core ideas, broad and gentle.' },
  {
    value: 'INTERMEDIATE',
    label: 'Intermediate',
    hint: 'Know the basics: the core plus the next layer.',
  },
  { value: 'ADVANCED', label: 'Advanced', hint: 'Pick one direction and go deep.' },
];

export const GOAL_OPTIONS: { value: Goal; label: string; hint: string }[] = [
  { value: 'EXAM', label: 'An exam', hint: 'Cover what gets tested.' },
  { value: 'JOB', label: 'Work', hint: 'Practical, hands-on.' },
  { value: 'CURIOSITY', label: 'Curiosity', hint: 'Understand how it works.' },
];

const LEVEL_WORDS: Record<Level, string> = {
  BEGINNER: 'a beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
};

/**
 * What the clarify screen says about a pre-filled level. The level is pre-selected but the
 * learner confirms it by starting (PRD §5.6); no match → nothing pre-filled, always ask.
 */
export function prefillNote(match: PrefillResponse['match']): string | null {
  if (!match) return null;
  return match.type === 'EXACT'
    ? `Last time you said you were ${LEVEL_WORDS[match.level]} in ${match.topicName}. Still right?`
    : `You're ${LEVEL_WORDS[match.level]} in ${match.topicName}, a related topic. Same level here?`;
}

/** The stages the progress screen walks through, in order. */
export const STAGES: { status: PathStatus; label: string }[] = [
  { status: 'GATHERING', label: 'Finding the official docs and popular resources' },
  { status: 'READING', label: 'Reading each resource' },
  { status: 'MAPPING', label: 'Mapping the concepts they cover' },
  { status: 'BUILDING', label: 'Building your path' },
];

/** Index of the current stage; a paused advanced path sits between mapping and building. */
export function stageIndex(status: PathStatus): number {
  if (status === 'AWAITING_BRANCH') return 3;
  if (status === 'READY') return STAGES.length;
  const index = STAGES.findIndex((stage) => stage.status === status);
  return index === -1 ? 0 : index;
}

/**
 * Whether to keep polling (docs/04-api-design.md §10): until `READY` / `FAILED`, or until a
 * paused path is waiting on the learner. Once a branch is picked, the job resumes: poll again.
 */
export function shouldPoll(path: Pick<LearningPath, 'status' | 'selectedBranch'>): boolean {
  if (path.status === 'READY' || path.status === 'FAILED') return false;
  if (path.status === 'AWAITING_BRANCH') return path.selectedBranch !== null;
  return true;
}

/** "Why is this here?": the evidence behind a kept concept. */
export function whyHere(
  concept: { coveredBy: number; officialCovers: boolean },
  resourceCount: number,
): string {
  const count = `${String(concept.coveredBy)} of ${String(resourceCount)} resources cover it`;
  return concept.officialCovers
    ? `${count}, including the official docs.`
    : concept.coveredBy === 0
      ? 'Not in the resources: a prerequisite or core idea Curio added from general knowledge.'
      : `${count}.`;
}

/** The outline with one module switched, progress recounted. */
export function withModuleEnabled(outline: Outline, moduleId: string, isEnabled: boolean): Outline {
  const modules = outline.modules.map((m) => (m.id === moduleId ? { ...m, isEnabled } : m));
  const enabled = modules.filter((m) => m.isEnabled);
  return {
    ...outline,
    modules,
    progress: {
      completed: enabled.filter((m) => m.completedAt !== null).length,
      enabled: enabled.length,
    },
  };
}

/** A module's relative difficulty within its path. */
export const DIFFICULTY_LABELS: Record<Level, string> = {
  BEGINNER: 'Easier',
  INTERMEDIATE: 'Medium',
  ADVANCED: 'Harder',
};

/** "25 min", "1 h 10 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/**
 * What the progress screen says about the resources while they are read or mapped: the ones
 * being worked on by name, and how many are done. Null in the other stages.
 */
export function resourceProgress(
  path: Pick<LearningPath, 'status' | 'resources'>,
): { label: string; active: string[]; done: number; total: number } | null {
  const usable = path.resources.filter((r) => r.state !== 'FAILED');
  if (path.status === 'READING') {
    return {
      label: 'Reading',
      active: path.resources.filter((r) => r.state === 'READING').map((r) => r.title),
      done: usable.filter((r) => r.state !== 'READING').length,
      total: path.resources.length,
    };
  }
  if (path.status === 'MAPPING') {
    return {
      label: 'Mapping',
      active: usable.filter((r) => r.state === 'READ').map((r) => r.title),
      done: usable.filter((r) => r.state === 'MAPPED').length,
      total: usable.length,
    };
  }
  return null;
}

/** Where "Start learning" goes: the first module turned on and not done (else the first on). */
export function firstModuleToLearn(
  modules: Pick<OutlineModule, 'id' | 'isEnabled' | 'completedAt'>[],
): string | null {
  const enabled = modules.filter((m) => m.isEnabled);
  return (enabled.find((m) => m.completedAt === null) ?? enabled[0])?.id ?? null;
}

export const classroomHref = (pathId: string, moduleId?: string | null) =>
  `/learn/${pathId}/classroom${moduleId ? `?module=${moduleId}` : ''}`;
