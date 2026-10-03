import { Router } from 'express';
import { createLearningPathsController } from '../controllers/learning-paths.controller.js';
import type { LearningPathsService } from '../services/learning-paths.service.js';

export function createLearningPathsRouter(service: LearningPathsService): Router {
  const controller = createLearningPathsController(service);
  const router = Router();

  // Read-only and not rate-limited (docs/04-api-design.md §6).
  router.get('/learning-paths/prefill', controller.prefill);

  return router;
}
