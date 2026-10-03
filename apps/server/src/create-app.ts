import cors from 'cors';
import express, { Router, type Express, type RequestHandler } from 'express';
import type { Logger } from 'pino';
import { requests, retrievalFlags, type RetrievalFlags } from './config/index.js';
import type { RerankProvider } from './lib/rerank/index.js';
import { hypotheticalPassage } from './pipelines/retrieval/hyde.js';
import { rerankChunks } from './pipelines/retrieval/rerank.js';
import { understandQuery } from './pipelines/retrieval/understand.js';
import type { Db } from './db/client.js';
import type { AuthProvider } from './lib/auth/index.js';
import type { EmbeddingsProvider } from './lib/embeddings/index.js';
import type { JobsProvider } from './lib/jobs/index.js';
import type { LlmProvider } from './lib/llm/index.js';
import type { LockProvider } from './lib/locks/index.js';
import type { RateLimiter } from './lib/rate-limit/index.js';
import type { StorageProvider } from './lib/storage/index.js';
import type { Tracer } from './lib/tracing/index.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { securityHeaders } from './middleware/security-headers.js';
import { countTokens } from './pipelines/ingestion/tokens.js';
import { createChatRepository } from './repositories/chat.repository.js';
import { createMemoriesRepository } from './repositories/memories.repository.js';
import { createTopicsRepository } from './repositories/topics.repository.js';
import { createNotebooksRepository } from './repositories/notebooks.repository.js';
import { createRetrievalRepository } from './repositories/retrieval.repository.js';
import { createSourcesRepository } from './repositories/sources.repository.js';
import { createUsersRepository } from './repositories/users.repository.js';
import { createChatRouter } from './routes/chat.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { createNotebooksRouter } from './routes/notebooks.routes.js';
import { createSourcesRouter } from './routes/sources.routes.js';
import { createChatService } from './services/chat.service.js';
import { createTopicsService } from './services/topics.service.js';
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
  embeddings: EmbeddingsProvider;
  llm: LlmProvider;
  /** The rerank step; required when the `rerank` flag is on. */
  reranker?: RerankProvider;
  tracer: Tracer;
  locks: LockProvider;
  rateLimiter: RateLimiter;
  /** Serves `/api/inngest`. It checks Inngest's request signature itself; there is no user auth. */
  jobsHandler: RequestHandler;
  /** Defaults to `config/flags.ts`; tests turn steps on. */
  flags?: RetrievalFlags;
}

export function createApp({
  logger,
  corsOrigins,
  db,
  auth,
  storage,
  jobs,
  embeddings,
  llm,
  reranker,
  tracer,
  locks,
  rateLimiter,
  jobsHandler,
  flags = retrievalFlags,
}: AppOptions): Express {
  const usersService = createUsersService(createUsersRepository(db));
  const topicsService = createTopicsService({
    repository: createTopicsRepository(db),
    embeddings,
    logger,
  });
  const notebooksService = createNotebooksService(
    createNotebooksRepository(db),
    storage,
    jobs,
    logger,
    topicsService,
  );
  const sourcesService = createSourcesService(createSourcesRepository(db), storage, jobs, logger);
  const retrievalRepository = createRetrievalRepository(db);
  const chatService = createChatService({
    repository: createChatRepository(db),
    memories: createMemoriesRepository(db),
    retrieval: {
      flags,
      embeddings,
      vectorSearch: (params) => retrievalRepository.vectorSearch(params),
      keywordSearch: (params) => retrievalRepository.keywordSearch(params),
      understandQuery: (input) => understandQuery(input, { llm }),
      hypotheticalPassage: (input) =>
        hypotheticalPassage(input, { llm }).then((result) => result.passage),
      ...(reranker ? { rerank: (input) => rerankChunks(input, { reranker }) } : {}),
    },
    llm,
    tracer,
    locks,
    jobs,
    countTokens,
    logger,
  });

  const api = Router();
  api.use(requireAuth(auth, usersService));
  api.use(createNotebooksRouter(notebooksService));
  api.use(createSourcesRouter(sourcesService, rateLimiter));
  api.use(createChatRouter(chatService, rateLimiter));

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
