import { z } from 'zod';

/** An exact origin (`https://host[:port]`): no path or trailing slash, or CORS never matches. */
const origin = z
  .string()
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    message: 'must be an origin like https://app.example.com (no path or trailing slash)',
  });

/**
 * Required: an empty list would block the web app with CORS and also turn off Clerk's
 * `authorizedParties` origin check.
 */
const corsOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(origin).min(1, 'must list at least one origin'));

/** `1`/`true` turns a flag on; unset is off. */
const flag = z
  .enum(['0', '1', 'true', 'false'])
  .default('0')
  .transform((value) => value === '1' || value === 'true');

const envSchema = z.object({
  // Unset means production: `development` turns on `pino-pretty`, a devDependency that isn't
  // installed in production builds, so defaulting to it crashes any non-Vercel deploy on boot.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: corsOrigins,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  CLERK_SECRET_KEY: z.string().startsWith('sk_'),
  CLERK_PUBLISHABLE_KEY: z.string().startsWith('pk_'),
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32-char hex Cloudflare account ID'),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  // Dev mode uses the local Inngest dev server: no keys, and requests to `/api/inngest` aren't
  // signed. Everywhere else both keys are required, and production refuses dev mode outright
  // (both checked in `loadEnv`).
  INNGEST_DEV: flag,
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  // Used by the ingestion job: embeddings, website scraping, YouTube transcripts.
  OPENAI_API_KEY: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),
  TRANSCRIPT_API_KEY: z.string().min(1),
  // Chat (Phase 5): traces, and the busy lock + rate limits.
  LANGFUSE_PUBLIC_KEY: z.string().min(1),
  LANGFUSE_SECRET_KEY: z.string().min(1),
  LANGFUSE_BASE_URL: z.url({ protocol: /^https?$/ }),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
});

const INNGEST_KEYS = ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'] as const;

/** Without dev mode, a missing key would leave `/api/inngest` unable to verify or send anything. */
function missingInngestKeys(source: NodeJS.ProcessEnv): string[] {
  const dev = flag.safeParse(source.INNGEST_DEV);
  if (dev.success && dev.data) return [];
  return INNGEST_KEYS.filter((name) => !source[name]).map(
    (name) => `${name} is required (or set INNGEST_DEV=1 to use the local Inngest dev server)`,
  );
}

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/** Validates env vars. Throws `EnvError` listing every missing or invalid var. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  const problems = result.success
    ? []
    : result.error.issues.map((issue) => {
        const name = issue.path.join('.');
        const raw = source[String(issue.path[0])];
        return raw === undefined || raw === ''
          ? `${name} is required`
          : `${name}: ${issue.message}`;
      });
  problems.push(...missingInngestKeys(source));
  if (result.success && result.data.NODE_ENV === 'production' && result.data.INNGEST_DEV) {
    problems.push(
      'INNGEST_DEV must not be set in production: it turns off the signature check on ' +
        '/api/inngest and sends events to a local dev server',
    );
  }
  if (!result.success || problems.length > 0) throw new EnvError(problems);
  return result.data;
}
