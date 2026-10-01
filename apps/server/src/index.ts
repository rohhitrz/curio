import type { Express } from 'express';
import {
  chunking,
  embeddingRequests,
  embeddings as embeddingModel,
  EnvError,
  extraction,
  ingestion,
  llmModels,
  llmRequests,
  llmTasks,
  loadEnv,
  tracing,
  type Env,
} from './config/index.js';
import { createApp } from './create-app.js';
import { createDb } from './db/client.js';
import { createCleanupNotebookFilesFunction } from './inngest/cleanup-notebook-files.js';
import { createProcessSourceFunction } from './inngest/process-source.js';
import { createSweepStuckSourcesFunction } from './inngest/sweep-stuck-sources.js';
import { Redis } from '@upstash/redis';
import { createClerkAuthProvider } from './lib/auth/index.js';
import { createOpenAiEmbeddings } from './lib/embeddings/index.js';
import {
  createInngestClient,
  createInngestHandler,
  createInngestJobsProvider,
} from './lib/jobs/index.js';
import { createOpenAiLlm } from './lib/llm/index.js';
import { createUpstashLocks } from './lib/locks/index.js';
import { createUnpdfParser } from './lib/pdf/index.js';
import { createUpstashRateLimiter } from './lib/rate-limit/index.js';
import { createFirecrawlScraper } from './lib/scraper/index.js';
import { createR2StorageProvider } from './lib/storage/index.js';
import { startLangfuseTracing } from './lib/tracing/index.js';
import { createSupadataTranscriptProvider } from './lib/transcript/index.js';
import { createLogger } from './logger.js';
import { countTokens } from './pipelines/ingestion/tokens.js';
import { createIngestionRepository } from './repositories/ingestion.repository.js';
import { createNotebooksRepository } from './repositories/notebooks.repository.js';
import { createIngestionService } from './services/ingestion.service.js';
import { createNotebooksService } from './services/notebooks.service.js';

let env: Env;
try {
  env = loadEnv();
} catch (error) {
  if (error instanceof EnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
const { db } = createDb(env.DATABASE_URL, (err) => {
  logger.warn({ err }, 'database: idle connection closed');
});
const auth = createClerkAuthProvider({
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  authorizedParties: env.CORS_ORIGINS,
});
const storage = createR2StorageProvider({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
});
const inngest = createInngestClient({
  isDev: env.INNGEST_DEV,
  eventKey: env.INNGEST_EVENT_KEY,
  signingKey: env.INNGEST_SIGNING_KEY,
  logger,
});
const jobs = createInngestJobsProvider(inngest);
const embeddings = createOpenAiEmbeddings({
  apiKey: env.OPENAI_API_KEY,
  model: embeddingModel.model,
  dimensions: embeddingModel.dimensions,
  batchSize: embeddingRequests.batchSize,
  timeoutMs: embeddingRequests.timeoutMs,
});
const llm = createOpenAiLlm({
  apiKey: env.OPENAI_API_KEY,
  models: llmModels,
  tasks: llmTasks,
  timeoutMs: llmRequests.timeoutMs,
  maxRetries: llmRequests.maxRetries,
});
// Process-wide (OpenTelemetry): once, before any traced call.
const { tracer } = startLangfuseTracing({
  publicKey: env.LANGFUSE_PUBLIC_KEY,
  secretKey: env.LANGFUSE_SECRET_KEY,
  baseUrl: env.LANGFUSE_BASE_URL,
  environment: process.env.VERCEL_ENV ?? env.NODE_ENV,
  maxTextChars: tracing.maxTextChars,
  // A Vercel function can freeze right after the response, so spans go out as they end.
  exportMode: process.env.VERCEL ? 'immediate' : 'batched',
});
const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });

const ingestionService = createIngestionService({
  repository: createIngestionRepository(db, ingestion.chunkInsertBatchSize),
  storage,
  pdf: createUnpdfParser(),
  scraper: createFirecrawlScraper({
    apiKey: env.FIRECRAWL_API_KEY,
    timeoutMs: extraction.scrapeTimeoutMs,
  }),
  transcript: createSupadataTranscriptProvider({
    apiKey: env.TRANSCRIPT_API_KEY,
    timeoutMs: extraction.transcriptTimeoutMs,
    jobPollAttempts: extraction.transcriptJobPollAttempts,
    jobPollIntervalMs: extraction.transcriptJobPollIntervalMs,
    language: extraction.transcriptLanguage,
  }),
  embeddings,
  jobs,
  logger,
  chunking: { ...chunking, countTokens },
  sweep: {
    processingTimeoutMinutes: ingestion.processingTimeoutMinutes,
    pendingResendMinutes: ingestion.pendingResendMinutes,
    batchSize: ingestion.sweepBatchSize,
  },
});
// The cleanup job only needs the service's file deletion; the app builds its own for requests.
const notebooksService = createNotebooksService(
  createNotebooksRepository(db),
  storage,
  jobs,
  logger,
);

const app: Express = createApp({
  logger,
  corsOrigins: env.CORS_ORIGINS,
  db,
  auth,
  storage,
  jobs,
  embeddings,
  llm,
  tracer,
  locks: createUpstashLocks(redis),
  rateLimiter: createUpstashRateLimiter(redis),
  jobsHandler: createInngestHandler(inngest, [
    createProcessSourceFunction(inngest, ingestionService),
    createSweepStuckSourcesFunction(inngest, ingestionService),
    createCleanupNotebookFilesFunction(inngest, notebooksService),
  ]),
});

// On Vercel the app runs as a function (default export); locally we listen.
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server listening');
  });
}

export default app;
