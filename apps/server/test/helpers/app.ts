import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';

export const testLogger = createLogger({ level: 'silent', pretty: false });

export function createTestApp() {
  return createApp({ logger: testLogger, corsOrigins: ['http://localhost:3000'] });
}
