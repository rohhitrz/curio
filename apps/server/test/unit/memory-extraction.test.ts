import { describe, expect, it } from 'vitest';
import { memoryExtraction } from '../../src/config/index.js';
import {
  buildExtractionMessage,
  screenOperations,
  sharesWordRun,
  type ExistingMemory,
  type ExtractionOperation,
} from '../../src/pipelines/memory/extract.js';
import { needsExtraction } from '../../src/services/memory-extraction.service.js';

const add = (
  content: string,
  overrides: Partial<ExtractionOperation> = {},
): ExtractionOperation => ({
  action: 'add',
  memoryId: null,
  kind: 'FACT',
  scope: 'GLOBAL',
  content,
  ...overrides,
});

const memory = (overrides: Partial<ExistingMemory> = {}): ExistingMemory => ({
  id: 'm1',
  scope: 'GLOBAL',
  kind: 'STYLE',
  content: 'Prefers short answers.',
  userEdited: false,
  ...overrides,
});

const answer =
  'Dropout randomly sets a fraction of the units to zero during training, which reduces overfitting in large networks.';

describe('sharesWordRun', () => {
  it('finds a run of n words, ignoring case and punctuation', () => {
    expect(
      sharesWordRun('Dropout randomly SETS a fraction of the units, to zero.', [answer], 8),
    ).toBe(true);
    expect(sharesWordRun('Is studying dropout for an exam next month.', [answer], 8)).toBe(false);
    // Shorter than n words can't share a run.
    expect(sharesWordRun('Dropout randomly sets', [answer], 8)).toBe(false);
  });
});

describe('screenOperations', () => {
  const context = { existing: [memory()], answers: [answer], hasTopic: true };

  it('keeps well-formed adds and updates', () => {
    const { accepted, rejected } = screenOperations(
      [
        add('Is a nurse.'),
        add('Is new to statistics.', { scope: 'TOPIC' }),
        {
          action: 'update',
          memoryId: 'm1',
          kind: null,
          scope: null,
          content: 'Prefers detailed answers.',
        },
      ],
      context,
    );
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      { action: 'add', kind: 'FACT', scope: 'GLOBAL', content: 'Is a nurse.' },
      { action: 'add', kind: 'FACT', scope: 'TOPIC', content: 'Is new to statistics.' },
      { action: 'update', memoryId: 'm1', content: 'Prefers detailed answers.' },
    ]);
  });

  it('source content is rejected', () => {
    const { accepted, rejected } = screenOperations(
      [add('Dropout randomly sets a fraction of the units to zero during training.')],
      context,
    );
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['source_like']);
  });

  it('drops empty, too long, duplicate, unknown, user-edited, kindless and topicless ops', () => {
    const { accepted, rejected } = screenOperations(
      [
        add('   '),
        add('x'.repeat(memoryExtraction.contentMaxChars + 1)),
        add('prefers short answers.'),
        { action: 'update', memoryId: 'nope', kind: null, scope: null, content: 'A' },
        { action: 'update', memoryId: null, kind: null, scope: null, content: 'B' },
        add('C', { kind: null }),
      ],
      { ...context, existing: [memory({ userEdited: false })] },
    );
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      'empty',
      'too_long',
      'duplicate',
      'unknown_memory',
      'unknown_memory',
      'missing_kind',
    ]);

    const edited = screenOperations(
      [{ action: 'update', memoryId: 'm1', kind: null, scope: null, content: 'Overwrite' }],
      { ...context, existing: [memory({ userEdited: true })] },
    );
    expect(edited.rejected.map((r) => r.reason)).toEqual(['user_edited']);

    const noTopic = screenOperations([add('Knows the basics.', { scope: 'TOPIC' })], {
      ...context,
      hasTopic: false,
    });
    expect(noTopic.rejected.map((r) => r.reason)).toEqual(['no_topic']);
  });

  it('caps new memories per run and drops repeats within one run', () => {
    const ops = Array.from({ length: memoryExtraction.maxNewPerRun + 2 }, (_, i) =>
      add(`Fact number ${i}.`),
    );
    const { accepted, rejected } = screenOperations([...ops, add('Fact number 0.')], context);
    expect(accepted).toHaveLength(memoryExtraction.maxNewPerRun);
    expect(rejected.map((r) => r.reason)).toEqual(['too_many', 'too_many', 'duplicate']);
  });
});

describe('buildExtractionMessage', () => {
  it('shows the topic, marks user-edited memories, cuts answers and strips markers', () => {
    const long = `${'word '.repeat(300)}end [1]`;
    const message = buildExtractionMessage({
      topicName: 'Statistics',
      existing: [memory({ userEdited: true })],
      messages: [
        { role: 'user', content: 'I am a nurse [2], explain simply' },
        { role: 'assistant', content: long },
      ],
    });
    expect(message.content).toContain('Notebook topic: Statistics');
    expect(message.content).toContain('- id m1 · GLOBAL · STYLE · set by the learner: Prefers');
    expect(message.content).toContain('Learner: I am a nurse [2], explain simply');
    expect(message.content).not.toContain('end [1]');
    expect(message.content).toContain('…');
  });

  it('no topic and no memories', () => {
    const message = buildExtractionMessage({
      topicName: null,
      existing: [],
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(message.content).toContain('Notebook topic: (none)');
    expect(message.content).toContain('Current memories:\n(none)');
  });
});

describe('needsExtraction', () => {
  it('only once more than the threshold is unscanned', () => {
    const n = memoryExtraction.afterMessages;
    expect(needsExtraction(n, 0)).toBe(false);
    expect(needsExtraction(n + 1, 0)).toBe(true);
    expect(needsExtraction(n + 10, 10)).toBe(false);
  });
});
