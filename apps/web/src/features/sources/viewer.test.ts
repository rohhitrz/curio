import { describe, expect, it } from 'vitest';
import {
  canReprocessSource,
  canViewSource,
  chunkLocation,
  formatTimestamp,
  splitForHighlight,
} from './viewer';

const noLocation = { pageNumber: null, startSeconds: null, endSeconds: null, headingPath: null };

describe('source actions by status', () => {
  it('text and chunks can be viewed only when READY', () => {
    expect(canViewSource({ status: 'READY' })).toBe(true);
    for (const status of ['PENDING', 'PROCESSING', 'FAILED'] as const) {
      expect(canViewSource({ status })).toBe(false);
    }
  });

  it('READY and FAILED sources can be processed again; active ones cannot', () => {
    expect(canReprocessSource({ status: 'READY' })).toBe(true);
    expect(canReprocessSource({ status: 'FAILED' })).toBe(true);
    expect(canReprocessSource({ status: 'PENDING' })).toBe(false);
    expect(canReprocessSource({ status: 'PROCESSING' })).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [75, '1:15'],
    [600, '10:00'],
    [3725, '1:02:05'],
    [12.9, '0:12'],
    [-5, '0:00'],
  ])('%d seconds → %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});

describe('chunkLocation', () => {
  it('PDF chunk → its page', () => {
    expect(chunkLocation({ ...noLocation, pageNumber: 3 })).toBe('Page 3');
  });

  it('YouTube chunk → its time range', () => {
    expect(chunkLocation({ ...noLocation, startSeconds: 75, endSeconds: 160 })).toBe('1:15 – 2:40');
    expect(chunkLocation({ ...noLocation, startSeconds: 0, endSeconds: null })).toBe('0:00');
  });

  it('website or text chunk → its heading path, or nothing before the first heading', () => {
    expect(chunkLocation({ ...noLocation, headingPath: 'Basics › Setup' })).toBe('Basics › Setup');
    expect(chunkLocation(noLocation)).toBeNull();
  });
});

describe('splitForHighlight', () => {
  const text = 'Gradient descent minimizes a loss.';

  it('splits the text around the passage', () => {
    expect(splitForHighlight(text, { start: 9, end: 16 })).toEqual({
      before: 'Gradient ',
      match: 'descent',
      after: ' minimizes a loss.',
    });
  });

  it('a passage at the very start or end works', () => {
    expect(splitForHighlight(text, { start: 0, end: 8 })?.before).toBe('');
    expect(splitForHighlight(text, { start: 29, end: text.length })?.after).toBe('');
  });

  it.each([
    ['no range', null],
    ['past the end of the text', { start: 10, end: 500 }],
    ['empty', { start: 5, end: 5 }],
    ['backwards', { start: 9, end: 4 }],
    ['negative', { start: -1, end: 4 }],
    ['not whole numbers', { start: 1.5, end: 4 }],
  ])('%s → no highlight', (_label, range) => {
    expect(splitForHighlight(text, range)).toBeNull();
  });
});
