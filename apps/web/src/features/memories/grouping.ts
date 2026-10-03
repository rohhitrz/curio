import type { Memory, MemoryKind } from '@curio/shared';

export interface MemoryGroup {
  /** `global` or the topic ID. */
  key: string;
  title: string;
  memories: Memory[];
}

export const KIND_LABELS: Record<MemoryKind, string> = {
  LEVEL: 'Level',
  STYLE: 'Learning style',
  GOAL: 'Goal',
  FACT: 'Background',
  UNDERSTOOD: 'Understands',
};

const kindOrder: Record<MemoryKind, number> = {
  LEVEL: 0,
  STYLE: 1,
  GOAL: 2,
  FACT: 3,
  UNDERSTOOD: 4,
};

/**
 * The memory page's sections: "About you" (global) first, then one per topic by name. Inside a
 * section, levels first, then style, goals, background, understood; newest first within a kind.
 */
export function groupMemories(memories: Memory[]): MemoryGroup[] {
  const groups = new Map<string, MemoryGroup>();
  for (const memory of memories) {
    const key = memory.topic?.id ?? 'global';
    const group = groups.get(key) ?? {
      key,
      title: memory.topic?.name ?? 'About you',
      memories: [],
    };
    group.memories.push(memory);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.memories.sort(
      (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.createdAt.localeCompare(a.createdAt),
    );
  }
  const global = groups.get('global');
  const topics = [...groups.values()]
    .filter((group) => group.key !== 'global')
    .sort((a, b) => a.title.localeCompare(b.title));
  return global ? [global, ...topics] : topics;
}

/**
 * Memories for the "Noted" notice: noted from a chat and not shown yet. Returns them oldest
 * first, plus the newest `createdAt` to ask from next time.
 */
export function newlyNoted(
  memories: Memory[],
  shown: ReadonlySet<string>,
): { noted: Memory[]; latest: string | null } {
  const noted = memories
    .filter((memory) => memory.origin === 'CHAT_EXTRACTED' && !shown.has(memory.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = memories.reduce<string | null>(
    (max, memory) => (max === null || memory.createdAt > max ? memory.createdAt : max),
    null,
  );
  return { noted, latest };
}
