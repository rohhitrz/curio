import { learnerProfile } from '../../config/index.js';

type Kind = 'LEVEL' | 'STYLE' | 'GOAL' | 'FACT' | 'UNDERSTOOD';

export interface ProfileMemory {
  kind: Kind;
  content: string;
  level: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | null;
  topicName: string | null;
}

/** Most useful for tone and depth first. */
const order: Record<Kind, number> = { LEVEL: 0, STYLE: 1, GOAL: 2, FACT: 3, UNDERSTOOD: 4 };

function line(memory: ProfileMemory): string {
  const topic = memory.topicName ? ` (${memory.topicName})` : '';
  if (memory.kind === 'LEVEL' && memory.level) {
    return `- Level${topic}: ${memory.level.toLowerCase()}`;
  }
  const label = {
    LEVEL: 'Level',
    STYLE: 'Style',
    GOAL: 'Goal',
    FACT: 'Background',
    UNDERSTOOD: 'Understands',
  }[memory.kind];
  return `- ${label}${topic}: ${memory.content.replace(/\s+/g, ' ').trim()}`;
}

/**
 * The learner profile for the chat prompt (pure): one line per memory, levels first, cut to
 * `learnerProfile.maxMemories` and `maxChars`. Null when there is nothing to say. Stable order
 * (kind, then the given order) keeps the prompt prefix cacheable between messages.
 */
export function formatLearnerProfile(memories: ProfileMemory[]): string | null {
  const sorted = memories
    .map((memory, index) => ({ memory, index }))
    .sort((a, b) => order[a.memory.kind] - order[b.memory.kind] || a.index - b.index)
    .slice(0, learnerProfile.maxMemories);
  const lines: string[] = [];
  let length = 0;
  for (const { memory } of sorted) {
    const next = line(memory);
    if (length + next.length + 1 > learnerProfile.maxChars) break;
    lines.push(next);
    length += next.length + 1;
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
