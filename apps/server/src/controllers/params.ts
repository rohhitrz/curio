import type { Request } from 'express';
import { z } from 'zod';
import { NotFoundError } from '../errors/app-error.js';

/** A malformed ID can't belong to the user, so it's a 404 like any other missing resource. */
function uuidParam(req: Request, name: string, notFoundMessage: string): string {
  const parsed = z.uuid().safeParse(req.params[name]);
  if (!parsed.success) throw new NotFoundError(notFoundMessage);
  return parsed.data;
}

export const notebookIdParam = (req: Request) =>
  uuidParam(req, 'notebookId', 'Notebook not found.');

export const sourceIdParam = (req: Request) => uuidParam(req, 'sourceId', 'Source not found.');

export const conversationIdParam = (req: Request) =>
  uuidParam(req, 'conversationId', 'Conversation not found.');

export const memoryIdParam = (req: Request) => uuidParam(req, 'memoryId', 'Memory not found.');

export const messageIdParam = (req: Request) => uuidParam(req, 'messageId', 'Message not found.');

export const pathIdParam = (req: Request) => uuidParam(req, 'pathId', 'Learning path not found.');

export const moduleIdParam = (req: Request) => uuidParam(req, 'moduleId', 'Module not found.');
