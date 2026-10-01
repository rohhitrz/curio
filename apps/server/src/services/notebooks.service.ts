import type { Notebook, NotebookDetail, Paginated } from '@curio/shared';
import type { Logger } from 'pino';
import { quotas } from '../config/index.js';
import { AppError, NotFoundError } from '../errors/app-error.js';
import type { JobsProvider } from '../lib/jobs/index.js';
import type { StorageProvider } from '../lib/storage/index.js';
import { decodeCursor, toPage } from '../pagination/cursor.js';
import type { NotebookRow, NotebooksRepository } from '../repositories/notebooks.repository.js';
import { isOwnUploadKey } from './upload-rules.js';

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

export function createNotebooksService(
  repository: NotebooksRepository,
  storage: StorageProvider,
  jobs: JobsProvider,
  logger: Logger,
) {
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
        sourceCount: await repository.countSources(row.id),
        conversationCount: await repository.countConversations(row.id),
        // Wired when learning paths exist (Phase 8).
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

    /**
     * Deletes the notebook and everything in it right away. Its uploaded files are removed from
     * R2 afterwards by the `notebook/deleted` job; if that can't be queued the files are orphans,
     * logged for the cleanup job (post-launch).
     */
    async delete(userId: string, notebookId: string): Promise<void> {
      const deleted = await repository.delete(userId, notebookId);
      if (!deleted) throw notFound();
      const { storageKeys } = deleted;
      if (storageKeys.length === 0) return;
      try {
        await jobs.send('notebook/deleted', { notebookId, userId, storageKeys });
      } catch (err) {
        logger.warn(
          { err, notebookId, storageKeys },
          'orphaned uploads: notebook/deleted not sent',
        );
      }
    },

    /**
     * Removes a deleted notebook's files from R2 (the `notebook/deleted` job). Deleting is
     * repeatable, so a failure is thrown and the whole batch is simply tried again.
     */
    async deleteFiles(userId: string, storageKeys: string[]): Promise<{ deleted: number }> {
      // The keys come from an event; never delete outside the user's own upload folder.
      const keys = storageKeys.filter((key) => isOwnUploadKey(userId, key));
      if (keys.length < storageKeys.length) {
        logger.error(
          { userId, storageKeys },
          'notebook/deleted carried keys outside the user folder',
        );
      }
      const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        throw new Error(`${failed.length} of ${keys.length} files could not be deleted`, {
          cause: failed[0]?.reason,
        });
      }
      return { deleted: keys.length };
    },
  };
}

export type NotebooksService = ReturnType<typeof createNotebooksService>;
