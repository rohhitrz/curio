import type { Request } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../errors/app-error.js';

/** A malformed ID can't belong to the user, so it's a 404 like any other missing notebook. */
export function notebookIdParam(req: Request): string {
  const parsed = z.uuid().safeParse(req.params.notebookId);
  if (!parsed.success) throw new NotFoundError('Notebook not found.');
  return parsed.data;
}
