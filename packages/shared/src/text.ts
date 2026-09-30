import { z } from 'zod';

/**
 * Removes NUL characters. Postgres can't store them in text or JSON, so one stray NUL (they turn
 * up in pasted text and in text pulled out of PDFs) would otherwise fail the whole write.
 */
export function stripNul(value: string): string {
  return value.replaceAll('\u0000', '');
}

/** A string input with NUL characters removed before any other rule is checked. */
export const cleanString = z.string().transform(stripNul);
