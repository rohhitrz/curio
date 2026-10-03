import type { Memory } from '@curio/shared';
import { describe, expect, it } from 'vitest';
import { groupMemories, newlyNoted } from './grouping';

function memory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    scope: 'GLOBAL',
    topic: null,
    kind: 'FACT',
    content: `Memory ${id}`,
    level: null,
    origin: 'CHAT_EXTRACTED',
    originLabel: 'Noted from a chat',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

const stats = { id: '00000000-0000-4000-8000-000000000001', name: 'Statistics' };
const bio = { id: '00000000-0000-4000-8000-000000000002', name: 'Biology' };

describe('groupMemories', () => {
  it('"About you" first, then topics by name; levels first inside a section', () => {
    const groups = groupMemories([
      memory('a', { scope: 'TOPIC', topic: stats, kind: 'FACT' }),
      memory('b', { scope: 'TOPIC', topic: bio }),
      memory('c'),
      memory('d', { scope: 'TOPIC', topic: stats, kind: 'LEVEL', level: 'BEGINNER' }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(['About you', 'Biology', 'Statistics']);
    expect(groups[2]?.memories.map((m) => m.id)).toEqual(['d', 'a']);
  });

  it('newest first within a kind; no "About you" without global memories', () => {
    const groups = groupMemories([
      memory('old', { scope: 'TOPIC', topic: stats, createdAt: '2026-10-01T00:00:00.000Z' }),
      memory('new', { scope: 'TOPIC', topic: stats, createdAt: '2026-10-02T00:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(['Statistics']);
    expect(groups[0]?.memories.map((m) => m.id)).toEqual(['new', 'old']);
  });
});

describe('newlyNoted', () => {
  it('only chat-noted memories not shown yet, oldest first; latest of all for the next check', () => {
    const result = newlyNoted(
      [
        memory('b', { createdAt: '2026-10-03T10:00:02.000Z' }),
        memory('a', { createdAt: '2026-10-03T10:00:01.000Z' }),
        memory('shown', { createdAt: '2026-10-03T10:00:03.000Z' }),
        memory('level', { origin: 'LEVEL_CONFIRMED', createdAt: '2026-10-03T10:00:04.000Z' }),
      ],
      new Set(['shown']),
    );
    expect(result.noted.map((m) => m.id)).toEqual(['a', 'b']);
    expect(result.latest).toBe('2026-10-03T10:00:04.000Z');
  });

  it('nothing new → no latest', () => {
    expect(newlyNoted([], new Set())).toEqual({ noted: [], latest: null });
  });
});
