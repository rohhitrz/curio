import {
  prefillQuerySchema,
  selectBranchSchema,
  startPathSchema,
  updateModuleSchema,
} from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { LearningPathsService } from '../services/learning-paths.service.js';
import { moduleIdParam, pathIdParam } from './params.js';

export function createLearningPathsController(service: LearningPathsService) {
  const prefill: RequestHandler = async (req, res) => {
    const { topic } = prefillQuerySchema.parse(req.query);
    res.json(await service.prefill(getUserId(req), topic));
  };

  const start: RequestHandler = async (req, res) => {
    const input = startPathSchema.parse(req.body);
    res.status(202).json(await service.start(getUserId(req), input));
  };

  const get: RequestHandler = async (req, res) => {
    res.json(await service.get(getUserId(req), pathIdParam(req)));
  };

  const selectBranch: RequestHandler = async (req, res) => {
    const pathId = pathIdParam(req);
    const { branch } = selectBranchSchema.parse(req.body);
    res.status(202).json(await service.selectBranch(getUserId(req), pathId, branch));
  };

  const retry: RequestHandler = async (req, res) => {
    res.status(202).json(await service.retry(getUserId(req), pathIdParam(req)));
  };

  const outline: RequestHandler = async (req, res) => {
    res.json(await service.outline(getUserId(req), pathIdParam(req)));
  };

  const updateModule: RequestHandler = async (req, res) => {
    const moduleId = moduleIdParam(req);
    const { isEnabled } = updateModuleSchema.parse(req.body);
    res.json(await service.updateModule(getUserId(req), moduleId, isEnabled));
  };

  return { prefill, start, get, selectBranch, retry, outline, updateModule };
}
