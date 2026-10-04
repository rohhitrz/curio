import { Router } from 'express';
import { createLessonsController } from '../controllers/lessons.controller.js';
import type { RateLimiter } from '../lib/rate-limit/index.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { LessonsService } from '../services/lessons.service.js';

export function createLessonsRouter(service: LessonsService, limiter: RateLimiter): Router {
  const controller = createLessonsController(service);
  const router = Router();

  router.get('/modules/:moduleId/lesson', controller.latest);
  // 50 / day (docs/04-api-design.md §10).
  router.post(
    '/modules/:moduleId/lessons',
    rateLimit(limiter, 'lessonGenerations'),
    controller.generate,
  );
  router.get('/lessons/:lessonId', controller.get);
  router.put('/modules/:moduleId/completion', controller.setCompletion);

  return router;
}
