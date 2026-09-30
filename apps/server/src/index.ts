import type { Express } from 'express';
import { EnvError, loadEnv, type Env } from './config/index.js';
import { createApp } from './create-app.js';
import { createDb } from './db/client.js';
import { createClerkAuthProvider } from './lib/auth/index.js';
import {
  createInngestClient,
  createInngestHandler,
  createInngestJobsProvider,
} from './lib/jobs/index.js';
import { createR2StorageProvider } from './lib/storage/index.js';
import { createLogger } from './logger.js';

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

const app: Express = createApp({
  logger,
  corsOrigins: env.CORS_ORIGINS,
  db,
  auth,
  storage,
  jobs: createInngestJobsProvider(inngest),
  // Job functions are added from step 3.5 (`processSource`).
  jobsHandler: createInngestHandler(inngest, []),
});

// On Vercel the app runs as a function (default export); locally we listen.
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'server listening');
  });
}

export default app;
