import type { RequestHandler } from 'express';
import { NotFoundError } from '../errors/app-error.js';

export const notFound: RequestHandler = () => {
  throw new NotFoundError('Route not found.');
};
