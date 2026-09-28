import { createApp } from './app.js';
import { EnvError, loadEnv, type Env } from './config/index.js';
import { createDb } from './db/client.js';
import { createClerkAuthProvider } from './lib/auth/index.js';
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

const app = createApp({ logger, corsOrigins: env.CORS_ORIGINS, db, auth });

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'server listening');
});
