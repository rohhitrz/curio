import cors from 'cors';
import express, { Router, type Express, type RequestHandler } from 'express';
import type { Logger } from 'pino';
import { requests } from './config/index.js';
import type { Db } from './db/client.js';
import type { AuthProvider } from './lib/auth/index.js';
import type { JobsProvider } from './lib/jobs/index.js';
import type { StorageProvider } from './lib/storage/index.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { securityHeaders } from './middleware/security-headers.js';
import { createNotebooksRepository } from './repositories/notebooks.repository.js';
import { createSourcesRepository } from './repositories/sources.repository.js';
import { createUsersRepository } from './repositories/users.repository.js';
import { healthRouter } from './routes/health.routes.js';
import { createNotebooksRouter } from './routes/notebooks.routes.js';
import { createSourcesRouter } from './routes/sources.routes.js';
import { createNotebooksService } from './services/notebooks.service.js';
import { createSourcesService } from './services/sources.service.js';
import { createUsersService } from './services/users.service.js';

export interface AppOptions {
  logger: Logger;
  corsOrigins: string[];
  db: Db;
  auth: AuthProvider;
  storage: StorageProvider;
  jobs: JobsProvider;
  /** Serves `/api/inngest`. It checks Inngest's request signature itself; there is no user auth. */
  jobsHandler: RequestHandler;
}

export function createApp({
  logger,
  corsOrigins,
  db,
  auth,
  storage,
  jobs,
  jobsHandler,
}: AppOptions): Express {
  const usersService = createUsersService(createUsersRepository(db));
  const notebooksService = createNotebooksService(createNotebooksRepository(db));
  const sourcesService = createSourcesService(createSourcesRepository(db), storage, jobs, logger);

  const api = Router();
  api.use(requireAuth(auth, usersService));
  api.use(createNotebooksRouter(notebooksService));
  api.use(createSourcesRouter(sourcesService));

  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(cors({ origin: corsOrigins, exposedHeaders: ['x-request-id', 'retry-after'] }));
  app.use(requestLogger(logger));
  // Mounted before the general JSON parser, which would apply its smaller limit first.
  app.use('/api/inngest', express.json({ limit: requests.inngestBodyLimit }), jobsHandler);
  app.use(express.json({ limit: requests.jsonBodyLimit }));

  app.use(healthRouter);
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
