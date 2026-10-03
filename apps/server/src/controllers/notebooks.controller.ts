import { createNotebookSchema, paginationQuerySchema, updateNotebookSchema } from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { NotebooksService } from '../services/notebooks.service.js';
import { notebookIdParam } from './params.js';

export function createNotebooksController(service: NotebooksService) {
  const list: RequestHandler = async (req, res) => {
    const { limit, cursor } = paginationQuerySchema.parse(req.query);
    res.json(await service.list(getUserId(req), limit, cursor));
  };

  const create: RequestHandler = async (req, res) => {
    const { title } = createNotebookSchema.parse(req.body);
    res.status(201).json(await service.create(getUserId(req), title));
  };

  const get: RequestHandler = async (req, res) => {
    res.json(await service.get(getUserId(req), notebookIdParam(req)));
  };

  const update: RequestHandler = async (req, res) => {
    const notebookId = notebookIdParam(req);
    const input = updateNotebookSchema.parse(req.body);
    res.json(await service.update(getUserId(req), notebookId, input));
  };

  const remove: RequestHandler = async (req, res) => {
    await service.delete(getUserId(req), notebookIdParam(req));
    res.status(204).end();
  };

  return { list, create, get, update, remove };
}
