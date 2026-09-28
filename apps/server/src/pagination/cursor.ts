import { z } from 'zod';
import { ValidationError } from '../errors/app-error.js';

/**
 * Keyset cursor: the last row's sort timestamp (full microsecond precision, as text) + ID.
 * Opaque to clients (base64url JSON).
 */
const cursorSchema = z.object({
  t: z.iso.datetime({ offset: true }),
  i: z.uuid(),
});

export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Decodes a client cursor; anything tampered or malformed → 400. */
export function decodeCursor(raw: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ValidationError({ cursor: 'Invalid cursor' });
  }
}

/** Given `limit + 1` rows, returns the page and the cursor for the next one. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}
