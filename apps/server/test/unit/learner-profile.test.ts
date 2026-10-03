import { describe, expect, it } from 'vitest';
import { learnerProfile } from '../../src/config/index.js';
import { formatLearnerProfile, type ProfileMemory } from '../../src/pipelines/memory/profile.js';
import { buildChatMessages, buildReplyMessages } from '../../src/pipelines/retrieval/prompt.js';

const memory = (overrides: Partial<ProfileMemory>): ProfileMemory => ({
  kind: 'FACT',
  content: 'Is a nurse.',
  level: null,
  topicName: null,
  ...overrides,
});

describe('formatLearnerProfile', () => {
  it('levels first, then style, goals, background, understood; topics named', () => {
    const profile = formatLearnerProfile([
      memory({ kind: 'UNDERSTOOD', content: 'Variance', topicName: 'Statistics' }),
      memory({ kind: 'FACT', content: 'Is a nurse.' }),
      memory({ kind: 'GOAL', content: 'Exam in June.' }),
      memory({ kind: 'STYLE', content: 'Likes  short\nanswers.' }),
      memory({ kind: 'LEVEL', content: 'ignored', level: 'BEGINNER', topicName: 'Statistics' }),
    ]);
    expect(profile).toBe(
      [
        '- Level (Statistics): beginner',
        '- Style: Likes short answers.',
        '- Goal: Exam in June.',
        '- Background: Is a nurse.',
        '- Understands (Statistics): Variance',
      ].join('\n'),
    );
  });

  it('null without memories; cut to the configured count and length', () => {
    expect(formatLearnerProfile([])).toBeNull();
    const many = Array.from({ length: learnerProfile.maxMemories + 5 }, (_, i) =>
      memory({ content: `Fact ${i}.` }),
    );
    expect(formatLearnerProfile(many)?.split('\n')).toHaveLength(learnerProfile.maxMemories);
    const long = Array.from({ length: 20 }, () => memory({ content: 'x'.repeat(250) }));
    expect(formatLearnerProfile(long)?.length).toBeLessThanOrEqual(learnerProfile.maxChars);
  });
});

describe('prompt with a profile', () => {
  it('comes first, apart from the sources, so it can never be cited', () => {
    const messages = buildChatMessages({
      question: 'What is variance?',
      contextText: '[1] Variance is the mean squared deviation.',
      summary: 'Earlier: the mean.',
      history: [],
      profile: '- Style: Likes analogies.',
    });
    expect(messages[0]?.content).toContain('About me, the learner');
    expect(messages[0]?.content).toContain('- Style: Likes analogies.');
    expect(messages[2]?.content).toContain('Summary of our earlier conversation');
    const last = messages.at(-1)?.content ?? '';
    expect(last).toContain('[1] Variance');
    expect(last).not.toContain('Likes analogies');
  });

  it('no profile → no profile turn; the reply prompt gets it too', () => {
    const plain = buildChatMessages({ question: 'Q', contextText: '[1] S', history: [] });
    expect(plain).toHaveLength(1);
    const reply = buildReplyMessages({ question: 'thanks!', history: [], profile: '- Fact' });
    expect(reply.map((m) => m.content)).toEqual([
      expect.stringContaining('- Fact'),
      'Understood.',
      'thanks!',
    ]);
  });
});
