import { describe, expect, it } from 'vitest';
import { learningPaths } from '../../src/config/index.js';
import { moduleMinutes } from '../../src/pipelines/learning/minutes.js';
import { NOT_BROAD, toScopeResult } from '../../src/pipelines/learning/scope.js';
import { resourceState } from '../../src/services/learning-paths.service.js';

describe('moduleMinutes', () => {
  const perConcept = learningPaths.minutesPerConcept;

  it('concepts × minutes for the level, rounded up to 5', () => {
    expect(moduleMinutes(3, 'BEGINNER', perConcept)).toBe(20); // 18
    expect(moduleMinutes(3, 'INTERMEDIATE', perConcept)).toBe(25); // 24
    expect(moduleMinutes(2, 'ADVANCED', perConcept)).toBe(20); // 20
    expect(moduleMinutes(1, 'BEGINNER', { ...perConcept, BEGINNER: 5 })).toBe(5);
  });

  it('a module with nothing left after the cut → 0', () => {
    expect(moduleMinutes(0, 'BEGINNER', perConcept)).toBe(0);
  });
});

describe('toScopeResult', () => {
  const limits = { minOptions: 2, maxOptions: 3, topicMax: 20 };
  const option = (label: string, topic: string) => ({ label, topic });

  it('not broad → no options, whatever the model listed', () => {
    expect(
      toScopeResult({ broad: false, question: 'q', options: [option('A', 'a')] }, limits),
    ).toEqual(NOT_BROAD);
  });

  it('trims, drops blank and repeated topics, cuts long topics, keeps at most maxOptions', () => {
    const result = toScopeResult(
      {
        broad: true,
        question: '  ',
        options: [
          option(' A ', ' Topic A '),
          option('A again', 'topic a'),
          option('', 'Blank label'),
          option('Long', 'A topic far longer than twenty characters'),
          option('C', 'Topic C'),
          option('D', 'Topic D'),
        ],
      },
      limits,
    );

    expect(result).toEqual({
      broad: true,
      question: null,
      options: [
        option('A', 'Topic A'),
        option('Long', 'A topic far longer'),
        option('C', 'Topic C'),
      ],
    });
  });

  it('broad with too few usable options → not broad', () => {
    expect(
      toScopeResult(
        { broad: true, question: 'q', options: [option('A', 'a'), option('', 'b')] },
        limits,
      ),
    ).toEqual(NOT_BROAD);
  });
});

describe('resourceState', () => {
  it('mapped wins; then failed, reading, and read (a deleted source counts as read)', () => {
    expect(resourceState({ sourceStatus: 'READY', mappedAt: new Date() })).toBe('MAPPED');
    expect(resourceState({ sourceStatus: 'FAILED', mappedAt: null })).toBe('FAILED');
    expect(resourceState({ sourceStatus: 'PENDING', mappedAt: null })).toBe('READING');
    expect(resourceState({ sourceStatus: 'PROCESSING', mappedAt: null })).toBe('READING');
    expect(resourceState({ sourceStatus: 'READY', mappedAt: null })).toBe('READ');
    expect(resourceState({ sourceStatus: null, mappedAt: null })).toBe('READ');
  });
});
