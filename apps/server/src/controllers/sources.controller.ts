import { createSourceSchema, createUploadSchema } from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { SourcesService } from '../services/sources.service.js';
import { notebookIdParam } from './params.js';

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

  return { createUpload, create };
}
