import type { RequestHandler } from 'express';
import { Inngest, type InngestFunction } from 'inngest';
import { serve } from 'inngest/express';
import type { Logger } from 'pino';
import type { JobsProvider } from './types.js';

const APP_ID = 'curio';

export interface InngestConfig {
  /** Dev mode talks to the local Inngest dev server and skips request signatures. */
  isDev: boolean;
  eventKey?: string;
  signingKey?: string;
  logger: Logger;
  /** Tests pass their own, so nothing reaches Inngest. */
  fetch?: typeof fetch;
}

/** `isDev` is always passed, so the SDK never falls back to reading `INNGEST_DEV` itself. */
export function createInngestClient({ isDev, eventKey, signingKey, logger, fetch }: InngestConfig) {
  return new Inngest({
    id: APP_ID,
    isDev,
    eventKey,
    signingKey,
    fetch,
    logger: logger.child({ component: 'inngest' }),
  });
}

export function createInngestJobsProvider(client: Inngest): JobsProvider {
  return {
    async send(name, data) {
      await client.send({ name, data });
    },
  };
}

/**
 * The endpoint Inngest calls to run jobs. Outside dev mode the SDK rejects any request that isn't
 * signed with the signing key, so only Inngest can trigger jobs.
 */
export function createInngestHandler(
  client: Inngest,
  functions: readonly InngestFunction.Like[],
): RequestHandler {
  return serve({ client, functions }) as RequestHandler;
}
