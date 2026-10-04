import { describe, expect, it } from 'vitest';
import {
  createMarkerFilter,
  DONE_MARKER,
  stripDoneMarker,
} from '../../src/pipelines/tutor/marker.js';
import { tutorContextBlock } from '../../src/pipelines/tutor/prompt.js';

/** Streams `parts` through a filter: what the learner sees, and whether the marker ended it. */
function run(parts: string[]) {
  const filter = createMarkerFilter();
  let shown = '';
  for (const part of parts) shown += filter.push(part);
  const { rest, found } = filter.end();
  return { shown: shown + rest, found };
}

describe('marker filter', () => {
  it('a final marker split across parts is never shown', () => {
    expect(run(['Great work! ', '<<MOD', 'ULE_', 'DONE>>', '\n'])).toEqual({
      shown: 'Great work! ',
      found: true,
    });
  });

  it('text that only looks like the start of the marker is passed through', () => {
    expect(run(['a << b', ' <<MODEL', ' c'])).toEqual({ shown: 'a << b <<MODEL c', found: false });
  });

  it('a marker with text after it is ordinary text, no action', () => {
    expect(run([`Say ${DONE_MARKER} to finish.`])).toEqual({
      shown: `Say ${DONE_MARKER} to finish.`,
      found: false,
    });
  });

  it('stripDoneMarker removes only a final marker from the saved reply', () => {
    expect(stripDoneMarker(`Well done.\n${DONE_MARKER}\n`)).toEqual({
      text: 'Well done.',
      found: true,
    });
    expect(stripDoneMarker(`x ${DONE_MARKER} y`)).toEqual({
      text: `x ${DONE_MARKER} y`,
      found: false,
    });
  });
});

describe('tutorContextBlock', () => {
  it('names the module, marks done modules and this one, and strips the lesson’s markers', () => {
    const block = tutorContextBlock({
      module: { id: 'm2', title: 'Training', summary: 'How it learns', why: 'It is the core' },
      modules: [
        { id: 'm1', title: 'Basics', summary: 'The basics', done: true },
        { id: 'm2', title: 'Training', summary: 'How it learns', done: false },
      ],
      lesson: 'Gradients flow backwards [1][2].',
    });

    expect(block).toContain(
      'Module: Training\nCovers: How it learns\nWhy it matters: It is the core',
    );
    expect(block).toContain(
      '1. [done] Basics: The basics\n2. Training: How it learns ← this module',
    );
    expect(block).toContain('Gradients flow backwards.');
    expect(block).not.toContain('[1]');
  });
});
