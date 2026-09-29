import { createSourceSchema, createUploadSchema, updateSourceSchema } from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { SourcesService } from '../services/sources.service.js';
import { notebookIdParam, sourceIdParam } from './params.js';

export function createSourcesController(service: SourcesService) {
  const createUpload: RequestHandler = async (req, res) => {
    const notebookId = notebookIdParam(req);
    const input = createUploadSchema.parse(req.body);
    res.json(await service.createUpload(getUserId(req), notebookId, input));
  };

  const create: RequestHandler = async (req, res) => {
    const notebookId = notebookIdParam(req);
    const input = createSourceSchema.parse(req.body);
    res.status(202).json(await service.create(getUserId(req), notebookId, input));
  };

  const list: RequestHandler = async (req, res) => {
    res.json(await service.list(getUserId(req), notebookIdParam(req)));
  };

  const get: RequestHandler = async (req, res) => {
    res.json(await service.get(getUserId(req), sourceIdParam(req)));
  };

  const update: RequestHandler = async (req, res) => {
    const sourceId = sourceIdParam(req);
    const { title } = updateSourceSchema.parse(req.body);
    res.json(await service.rename(getUserId(req), sourceId, title));
  };

  const remove: RequestHandler = async (req, res) => {
    await service.delete(getUserId(req), sourceIdParam(req));
    res.status(204).end();
  };

  const fileUrl: RequestHandler = async (req, res) => {
    res.json(await service.fileUrl(getUserId(req), sourceIdParam(req)));
  };

  return { createUpload, create, list, get, update, remove, fileUrl };
}
