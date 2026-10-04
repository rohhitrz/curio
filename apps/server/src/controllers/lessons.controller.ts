import { moduleCompletionSchema } from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { LessonsService } from '../services/lessons.service.js';
import { lessonIdParam, moduleIdParam } from './params.js';
import { stream } from './stream.js';

export function createLessonsController(service: LessonsService) {
  const latest: RequestHandler = async (req, res) => {
    res.json(await service.latest(getUserId(req), moduleIdParam(req)));
  };

  const generate: RequestHandler = async (req, res) => {
    await stream(res, await service.generate(getUserId(req), moduleIdParam(req)));
  };

  const get: RequestHandler = async (req, res) => {
    res.json(await service.get(getUserId(req), lessonIdParam(req)));
  };

  const setCompletion: RequestHandler = async (req, res) => {
    const moduleId = moduleIdParam(req);
    const { completed } = moduleCompletionSchema.parse(req.body);
    res.json(await service.setCompletion(getUserId(req), moduleId, completed));
  };

  return { latest, generate, get, setCompletion };
}
