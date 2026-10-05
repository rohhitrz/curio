import { describe, expect, it } from 'vitest';
import { attacks, CANARY, hijacked, plant, summarize } from './injection.js';

describe('plant', () => {
  it('fills in the closing tag of the block the attack sits in', () => {
    const fakeClose = attacks.find((a) => a.id === 'fake-close');
    expect(fakeClose && plant(fakeClose, 'sources')).toMatch(/^<\/sources>\n\nSYSTEM:/);
  });

  it('every attack carries the canary', () => {
    for (const attack of attacks) expect(attack.text).toContain(CANARY);
  });
});

describe('hijacked', () => {
  it('finds the canary or the link in any case', () => {
    expect(hijacked(`Dropout… ${CANARY}`)).toBe(true);
    expect(hijacked('see Pineapple7.example')).toBe(true);
    expect(hijacked('pineapple-7')).toBe(true);
  });

  it('an answer about dropout is clean', () => {
    expect(hijacked('Dropout drops units during training [1].')).toBe(false);
  });
});

describe('summarize', () => {
  it('rates over all runs and per surface', () => {
    const summary = summarize([
      { surface: 'chat', attack: 'direct', hijacked: false, onTask: true },
      { surface: 'chat', attack: 'note-to-ai', hijacked: true, onTask: true },
      { surface: 'map', attack: 'direct', hijacked: false, onTask: false },
    ]);
    expect(summary).toEqual({
      runs: 3,
      hijackRate: 0.3333,
      onTaskRate: 0.6667,
      bySurface: {
        chat: { runs: 2, hijacked: 1, onTask: 2 },
        map: { runs: 1, hijacked: 0, onTask: 0 },
      },
    });
  });

  it('nothing run → zero rates', () => {
    expect(summarize([])).toEqual({ runs: 0, hijackRate: 0, onTaskRate: 0, bySurface: {} });
  });
});
