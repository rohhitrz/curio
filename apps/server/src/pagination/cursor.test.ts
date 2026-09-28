import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors/app-error.js';
import { decodeCursor, encodeCursor, toPage } from './cursor.js';

const cursor = { t: '2026-09-28T14:21:49.123456Z', i: '6f1d1c2e-4b8a-4e6b-9b1e-2f0c5d8a7e11' };

describe('cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is opaque (base64url)', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['valid base64, not JSON', Buffer.from('hello').toString('base64url')],
    ['wrong shape', Buffer.from(JSON.stringify({ t: 'x', i: 1 })).toString('base64url')],
    ['tampered id', encodeCursor(cursor).slice(0, -4) + 'AAAA'],
  ])('tampered cursor (%s) → 400', (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrow(ValidationError);
  });

  it('toPage returns a next cursor only when there are more rows', () => {
    const rows = [1, 2, 3].map((n) => ({ n, c: { ...cursor, t: `2026-09-2${n}T00:00:00Z` } }));

    const more = toPage(rows, 2, (r) => r.c);
    expect(more.items.map((r) => r.n)).toEqual([1, 2]);
    expect(decodeCursor(more.nextCursor ?? '')).toEqual(rows[1]?.c);

    const last = toPage(rows, 3, (r) => r.c);
    expect(last.nextCursor).toBeNull();
  });
});
