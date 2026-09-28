import type { RequestHandler } from 'express';
import * as helmetModule from 'helmet';
import type { HelmetOptions } from 'helmet';

type Helmet = (options?: HelmetOptions) => RequestHandler;

/**
 * helmet ships separate ESM and CJS type definitions. Locally its default export is the
 * function; Vercel's build resolves the CJS types, where `default` is the module object.
 * At runtime both shapes are callable, so resolve the function whichever way it arrives.
 */
function resolveHelmet(): Helmet {
  const candidate: unknown = helmetModule.default;
  if (typeof candidate === 'function') return candidate as Helmet;
  return (candidate as { default: Helmet }).default;
}

/** Security headers (CSP, HSTS, no-sniff, frame options, …). */
export function securityHeaders(options?: HelmetOptions): RequestHandler {
  return resolveHelmet()(options);
}
