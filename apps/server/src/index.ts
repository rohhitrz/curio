import { createApp } from './app.js';
import { createLogger } from './logger.js';

// Temporary: replaced by validated config in step 0.4.
const port = Number(process.env.PORT ?? 4000);
const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  pretty: process.env.NODE_ENV === 'development',
});
const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);

const app = createApp({ logger, corsOrigins });

app.listen(port, () => {
  logger.info({ port }, 'server listening');
});
