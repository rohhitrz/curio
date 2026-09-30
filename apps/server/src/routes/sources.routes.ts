import { Router } from 'express';
import { createSourcesController } from '../controllers/sources.controller.js';
import type { SourcesService } from '../services/sources.service.js';

export function createSourcesRouter(service: SourcesService): Router {
  const controller = createSourcesController(service);
  const router = Router();

  router.get('/notebooks/:notebookId/sources', controller.list);
  router.post('/notebooks/:notebookId/uploads', controller.createUpload);
  router.post('/notebooks/:notebookId/sources', controller.create);
  router.get('/sources/:sourceId', controller.get);
  router.patch('/sources/:sourceId', controller.update);
  router.delete('/sources/:sourceId', controller.remove);
  router.get('/sources/:sourceId/file-url', controller.fileUrl);
  router.get('/sources/:sourceId/content', controller.content);
  router.get('/sources/:sourceId/chunks', controller.chunks);
  router.post('/sources/:sourceId/reprocess', controller.reprocess);

  return router;
}
