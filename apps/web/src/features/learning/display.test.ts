import { describe, expect, it } from 'vitest';
import type { Outline } from '@curio/shared';
import { prefillNote, shouldPoll, stageIndex, STAGES, whyHere, withModuleEnabled } from './display';

describe('prefillNote', () => {
  it('asks to confirm an exact or related level; nothing without a match', () => {
    expect(prefillNote({ type: 'EXACT', topicName: 'Deep Learning', level: 'BEGINNER' })).toBe(
      'Last time you said you were a beginner in Deep Learning. Still right?',
    );
    expect(prefillNote({ type: 'RELATED', topicName: 'Machine Learning', level: 'ADVANCED' })).toBe(
      "You're advanced in Machine Learning, a related topic. Same level here?",
    );
    expect(prefillNote(null)).toBeNull();
  });
});

describe('stageIndex', () => {
  it('follows the job; a paused path sits at building; READY is past the last stage', () => {
    expect(STAGES.map((s) => stageIndex(s.status))).toEqual([0, 1, 2, 3]);
    expect(stageIndex('AWAITING_BRANCH')).toBe(3);
    expect(stageIndex('READY')).toBe(STAGES.length);
  });
});

describe('shouldPoll', () => {
  it('polls while the job works or after a branch pick; stops when done or waiting on the learner', () => {
    expect(shouldPoll({ status: 'GATHERING', selectedBranch: null })).toBe(true);
    expect(shouldPoll({ status: 'BUILDING', selectedBranch: null })).toBe(true);
    expect(shouldPoll({ status: 'AWAITING_BRANCH', selectedBranch: null })).toBe(false);
    expect(shouldPoll({ status: 'AWAITING_BRANCH', selectedBranch: 'Theory' })).toBe(true);
    expect(shouldPoll({ status: 'READY', selectedBranch: null })).toBe(false);
    expect(shouldPoll({ status: 'FAILED', selectedBranch: null })).toBe(false);
  });
});

describe('whyHere', () => {
  it('states the evidence', () => {
    expect(whyHere({ coveredBy: 5, officialCovers: true }, 6)).toBe(
      '5 of 6 resources cover it, including the official docs.',
    );
    expect(whyHere({ coveredBy: 2, officialCovers: false }, 6)).toBe('2 of 6 resources cover it.');
    expect(whyHere({ coveredBy: 0, officialCovers: false }, 6)).toBe(
      'Not in the resources: a prerequisite or core idea Curio added from general knowledge.',
    );
  });
});

describe('withModuleEnabled', () => {
  const module = (id: string, isEnabled: boolean, completedAt: string | null = null) => ({
    id,
    position: 1,
    title: id,
    summary: '',
    isEnabled,
    completedAt,
    hasLesson: false,
    concepts: [],
  });

  it('switches one module and recounts progress over enabled modules', () => {
    const outline: Outline = {
      hook: null,
      modules: [
        module('a', true, '2026-10-03T10:00:00.000Z'),
        module('b', true),
        module('c', false),
      ],
      skipped: [],
      resources: [],
      progress: { completed: 1, enabled: 2 },
    };

    const off = withModuleEnabled(outline, 'a', false);

    expect(off.modules.map((m) => m.isEnabled)).toEqual([false, true, false]);
    expect(off.progress).toEqual({ completed: 0, enabled: 1 });
    expect(withModuleEnabled(outline, 'c', true).progress).toEqual({ completed: 1, enabled: 3 });
  });
});
