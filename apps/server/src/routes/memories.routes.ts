import { Router } from 'express';
import { createMemoriesController } from '../controllers/memories.controller.js';
import type { MemoriesService } from '../services/memories.service.js';

export function createMemoriesRouter(service: MemoriesService): Router {
  const controller = createMemoriesController(service);
  const router = Router();

  router.get('/memories', controller.list);
  router.delete('/memories', controller.removeAll);
  router.patch('/memories/:memoryId', controller.update);
  router.delete('/memories/:memoryId', controller.remove);

  return router;
}
