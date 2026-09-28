import { describe, expect, it } from 'vitest';
import { timeAgo } from './format';

const now = Date.parse('2026-09-28T12:00:00Z');

describe('timeAgo', () => {
  it.each([
    ['2026-09-28T11:59:30Z', 'just now'],
    ['2026-09-28T11:57:00Z', '3 minutes ago'],
    ['2026-09-28T10:00:00Z', '2 hours ago'],
    ['2026-09-27T12:00:00Z', 'yesterday'],
    ['2026-09-14T12:00:00Z', '2 weeks ago'],
  ])('%s → %s', (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected);
  });
});
