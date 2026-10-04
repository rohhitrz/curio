import { Router } from 'express';
import { createLearningPathsController } from '../controllers/learning-paths.controller.js';
import type { RateLimiter } from '../lib/rate-limit/index.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { LearningPathsService } from '../services/learning-paths.service.js';

export function createLearningPathsRouter(
  service: LearningPathsService,
  limiter: RateLimiter,
): Router {
  const controller = createLearningPathsController(service);
  const router = Router();

  // Read-only and not rate-limited (docs/04-api-design.md §6).
  router.get('/learning-paths/prefill', controller.prefill);
  // One model call each: 30 / day (L-11).
  router.get('/learning-paths/scope', rateLimit(limiter, 'pathScopeChecks'), controller.scope);
  // 5 / day; retries don't count (docs/04-api-design.md §10).
  router.post('/learning-paths', rateLimit(limiter, 'learningPaths'), controller.start);
  router.get('/learning-paths/:pathId', controller.get);
  router.post('/learning-paths/:pathId/branch', controller.selectBranch);
  router.post('/learning-paths/:pathId/retry', controller.retry);
  router.get('/learning-paths/:pathId/outline', controller.outline);
  router.patch('/modules/:moduleId', controller.updateModule);

  return router;
}
