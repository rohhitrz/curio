import type { Notebook, NotebookDetail, Paginated } from '@curio/shared';
import { quotas } from '../config/index.js';
import { AppError, NotFoundError } from '../errors/app-error.js';
import { decodeCursor, toPage } from '../pagination/cursor.js';
import type { NotebookRow, NotebooksRepository } from '../repositories/notebooks.repository.js';

function toNotebook(row: NotebookRow): Notebook {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const notFound = () => new NotFoundError('Notebook not found.');

export function createNotebooksService(repository: NotebooksRepository) {
  return {
    async list(userId: string, limit: number, rawCursor?: string): Promise<Paginated<Notebook>> {
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      const rows = await repository.listByUser(userId, limit, cursor);
      const page = toPage(rows, limit, (row) => ({ t: row.cursorTimestamp, i: row.id }));
      return { items: page.items.map(toNotebook), nextCursor: page.nextCursor };
    },

    async get(userId: string, notebookId: string): Promise<NotebookDetail> {
      const row = await repository.findById(userId, notebookId);
      if (!row) throw notFound();
      return {
        ...toNotebook(row),
        // Wired to real counts when sources (Phase 2), conversations (Phase 5),
        // and learning paths (Phase 8) exist.
        sourceCount: 0,
        conversationCount: 0,
        learningPathId: null,
      };
    },

    async create(userId: string, title: string): Promise<Notebook> {
      const row = await repository.createWithinQuota(userId, title, quotas.notebooksPerUser);
      if (!row) {
        throw new AppError(
          'QUOTA_EXCEEDED',
          `You can have up to ${quotas.notebooksPerUser} notebooks. Delete one to create another.`,
        );
      }
      return toNotebook(row);
    },

    async rename(userId: string, notebookId: string, title: string): Promise<Notebook> {
      const row = await repository.updateTitle(userId, notebookId, title);
      if (!row) throw notFound();
      return toNotebook(row);
    },

    async delete(userId: string, notebookId: string): Promise<void> {
      const deleted = await repository.delete(userId, notebookId);
      if (!deleted) throw notFound();
    },
  };
}

export type NotebooksService = ReturnType<typeof createNotebooksService>;
