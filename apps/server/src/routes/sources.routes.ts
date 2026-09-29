import { Router } from 'express';
import { createSourcesController } from '../controllers/sources.controller.js';
import type { SourcesService } from '../services/sources.service.js';

export function createSourcesRouter(service: SourcesService): Router {
  const controller = createSourcesController(service);
  const router = Router();

  router.post('/notebooks/:notebookId/uploads', controller.createUpload);
  router.post('/notebooks/:notebookId/sources', controller.create);

  return router;
}
