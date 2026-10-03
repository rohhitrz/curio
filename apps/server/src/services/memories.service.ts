import type {
  Memory,
  MemoryList,
  MemoryListQuery,
  MemoryOrigin,
  UpdateMemoryInput,
} from '@curio/shared';
import { NotFoundError, ValidationError } from '../errors/app-error.js';
import type { MemoriesRepository, MemoryRow } from '../repositories/memories.repository.js';

/** Where a memory came from, as the memory page shows it (API doc §7: built by the server). */
export const ORIGIN_LABELS: Record<MemoryOrigin, string> = {
  LEVEL_CONFIRMED: 'You confirmed this level',
  LESSON_COMPLETED: 'From a lesson you completed',
  CHAT_EXTRACTED: 'Noted from a chat',
  USER_EDITED: 'Edited by you',
};

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope,
    topic: row.topicId && row.topicName ? { id: row.topicId, name: row.topicName } : null,
    kind: row.kind,
    content: row.content,
    level: row.level,
    origin: row.origin,
    originLabel: ORIGIN_LABELS[row.origin],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const notFound = () => new NotFoundError('Memory not found.');

/** The memory page (API doc §7). Every call is scoped to the user; others' memories are 404. */
export function createMemoriesService(repository: MemoriesRepository) {
  return {
    async list(userId: string, query: MemoryListQuery): Promise<MemoryList> {
      const rows = await repository.list(userId, {
        ...(query.scope ? { scope: query.scope } : {}),
        ...(query.topicId ? { topicId: query.topicId } : {}),
        ...(query.since ? { since: new Date(query.since) } : {}),
      });
      return { items: rows.map(toMemory) };
    },

    /**
     * Edits text and/or level. Any edit makes the memory the user's own (`USER_EDITED`), which
     * the extraction job never changes (decision M-04).
     */
    async update(userId: string, memoryId: string, input: UpdateMemoryInput): Promise<Memory> {
      const existing = await repository.findById(userId, memoryId);
      if (!existing) throw notFound();
      if (input.level !== undefined && existing.kind !== 'LEVEL') {
        throw new ValidationError({ level: 'Only a level memory has a level.' });
      }
      const row = await repository.update(userId, memoryId, {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        origin: 'USER_EDITED',
      });
      if (!row) throw notFound();
      return toMemory(row);
    },

    async delete(userId: string, memoryId: string): Promise<void> {
      if (!(await repository.delete(userId, memoryId))) throw notFound();
    },

    async deleteAll(userId: string): Promise<void> {
      await repository.deleteAll(userId);
    },
  };
}

export type MemoriesService = ReturnType<typeof createMemoriesService>;
