import { memoryListQuerySchema, updateMemorySchema } from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { MemoriesService } from '../services/memories.service.js';
import { memoryIdParam } from './params.js';

export function createMemoriesController(service: MemoriesService) {
  const list: RequestHandler = async (req, res) => {
    const query = memoryListQuerySchema.parse(req.query);
    res.json(await service.list(getUserId(req), query));
  };

  const update: RequestHandler = async (req, res) => {
    const memoryId = memoryIdParam(req);
    const input = updateMemorySchema.parse(req.body);
    res.json(await service.update(getUserId(req), memoryId, input));
  };

  const remove: RequestHandler = async (req, res) => {
    await service.delete(getUserId(req), memoryIdParam(req));
    res.status(204).end();
  };

  const removeAll: RequestHandler = async (req, res) => {
    await service.deleteAll(getUserId(req));
    res.status(204).end();
  };

  return { list, update, remove, removeAll };
}
