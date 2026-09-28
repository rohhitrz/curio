import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { Db } from './db/client.js';
import type { AuthProvider } from './lib/auth/index.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { createNotebooksRepository } from './repositories/notebooks.repository.js';
import { createUsersRepository } from './repositories/users.repository.js';
import { healthRouter } from './routes/health.routes.js';
import { createNotebooksRouter } from './routes/notebooks.routes.js';
import { createNotebooksService } from './services/notebooks.service.js';
import { createUsersService } from './services/users.service.js';

export interface AppOptions {
  logger: Logger;
  corsOrigins: string[];
  db: Db;
  auth: AuthProvider;
}

export function createApp({ logger, corsOrigins, db, auth }: AppOptions): Express {
  const usersService = createUsersService(createUsersRepository(db));
  const notebooksService = createNotebooksService(createNotebooksRepository(db));

  const api = Router();
  api.use(requireAuth(auth, usersService));
  api.use(createNotebooksRouter(notebooksService));

  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, exposedHeaders: ['x-request-id', 'retry-after'] }));
  app.use(requestLogger(logger));
  app.use(express.json());

  app.use(healthRouter);
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
