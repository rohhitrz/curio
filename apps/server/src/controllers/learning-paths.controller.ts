import { prefillQuerySchema } from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { LearningPathsService } from '../services/learning-paths.service.js';

export function createLearningPathsController(service: LearningPathsService) {
  const prefill: RequestHandler = async (req, res) => {
    const { topic } = prefillQuerySchema.parse(req.query);
    res.json(await service.prefill(getUserId(req), topic));
  };

  return { prefill };
}
