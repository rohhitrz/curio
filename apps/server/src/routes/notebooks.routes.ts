import { Router } from 'express';
import { createNotebooksController } from '../controllers/notebooks.controller.js';
import type { NotebooksService } from '../services/notebooks.service.js';

export function createNotebooksRouter(service: NotebooksService): Router {
  const controller = createNotebooksController(service);
  const router = Router();

  router.get('/notebooks', controller.list);
  router.post('/notebooks', controller.create);
  router.get('/notebooks/:notebookId', controller.get);
  router.patch('/notebooks/:notebookId', controller.update);
  router.delete('/notebooks/:notebookId', controller.remove);

  return router;
}
