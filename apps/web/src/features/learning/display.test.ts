import { describe, expect, it } from 'vitest';
import type { Outline } from '@curio/shared';
import {
  classroomHref,
  firstModuleToLearn,
  formatMinutes,
  prefillNote,
  resourceProgress,
  shouldPoll,
  stageIndex,
  STAGES,
  whyHere,
  withModuleEnabled,
} from './display';

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
    why: null,
    difficulty: null,
    minutes: 0,
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

describe('resourceProgress', () => {
  const r = (title: string, state: 'READING' | 'READ' | 'FAILED' | 'MAPPED') => ({
    id: title,
    title,
    state,
  });
  const resources = [
    r('Docs', 'MAPPED'),
    r('Guide', 'READ'),
    r('Video', 'FAILED'),
    r('Blog', 'READ'),
  ];

  it('while mapping: names the read ones not mapped yet, counts the mapped (failed left out)', () => {
    expect(resourceProgress({ status: 'MAPPING', resources })).toEqual({
      label: 'Mapping',
      active: ['Guide', 'Blog'],
      done: 1,
      total: 3,
    });
  });

  it('while reading: names the ones being read; nothing in other stages', () => {
    const reading = [r('Docs', 'READING'), r('Guide', 'READ'), r('Video', 'FAILED')];
    expect(resourceProgress({ status: 'READING', resources: reading })).toEqual({
      label: 'Reading',
      active: ['Docs'],
      done: 1,
      total: 3,
    });
    expect(resourceProgress({ status: 'BUILDING', resources })).toBeNull();
  });
});

describe('firstModuleToLearn', () => {
  it('the first turned-on module not done; all done → the first turned on; none → null', () => {
    const m = (id: string, isEnabled: boolean, done: boolean) => ({
      id,
      isEnabled,
      completedAt: done ? '2026-10-04T10:00:00.000Z' : null,
    });
    expect(
      firstModuleToLearn([m('a', true, true), m('b', false, false), m('c', true, false)]),
    ).toBe('c');
    expect(firstModuleToLearn([m('a', false, false), m('b', true, true)])).toBe('b');
    expect(firstModuleToLearn([m('a', false, false)])).toBeNull();
  });
});

describe('formatMinutes and classroomHref', () => {
  it('minutes under an hour, then hours', () => {
    expect(formatMinutes(25)).toBe('25 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(95)).toBe('1 h 35 min');
  });

  it('links a module in the classroom', () => {
    expect(classroomHref('p1', 'm1')).toBe('/learn/p1/classroom?module=m1');
    expect(classroomHref('p1')).toBe('/learn/p1/classroom');
  });
});
