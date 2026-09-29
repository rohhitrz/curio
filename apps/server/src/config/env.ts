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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
});

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
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.');
        const raw = source[String(issue.path[0])];
        return raw === undefined || raw === ''
          ? `${name} is required`
          : `${name}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
