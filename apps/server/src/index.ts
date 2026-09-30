import type { Express } from 'express';
import {
  chunking,
  embeddingRequests,
  embeddings as embeddingModel,
  EnvError,
  extraction,
  ingestion,
  loadEnv,
  type Env,
} from './config/index.js';
import { createApp } from './create-app.js';
import { createDb } from './db/client.js';
import { createProcessSourceFunction } from './inngest/process-source.js';
import { createClerkAuthProvider } from './lib/auth/index.js';
import { createOpenAiEmbeddings } from './lib/embeddings/index.js';
import {
  createInngestClient,
  createInngestHandler,
  createInngestJobsProvider,
} from './lib/jobs/index.js';
import { createUnpdfParser } from './lib/pdf/index.js';
import { createFirecrawlScraper } from './lib/scraper/index.js';
import { createR2StorageProvider } from './lib/storage/index.js';
import { createSupadataTranscriptProvider } from './lib/transcript/index.js';
import { createLogger } from './logger.js';
import { countTokens } from './pipelines/ingestion/tokens.js';
import { createIngestionRepository } from './repositories/ingestion.repository.js';
import { createIngestionService } from './services/ingestion.service.js';

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
const { db } = createDb(env.DATABASE_URL);
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
  }),
  embeddings: createOpenAiEmbeddings({
    apiKey: env.OPENAI_API_KEY,
    model: embeddingModel.model,
    dimensions: embeddingModel.dimensions,
    batchSize: embeddingRequests.batchSize,
    timeoutMs: embeddingRequests.timeoutMs,
  }),
  logger,
  chunking: { ...chunking, countTokens },
});

const app: Express = createApp({
  logger,
  corsOrigins: env.CORS_ORIGINS,
  db,
  auth,
  storage,
  jobs: createInngestJobsProvider(inngest),
  jobsHandler: createInngestHandler(inngest, [
    createProcessSourceFunction(inngest, ingestionService),
  ]),
});

// On Vercel the app runs as a function (default export); locally we listen.
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server listening');
  });
}

export default app;
