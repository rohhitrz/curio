# PROGRESS — Curio

> Updated by the agent in the same commit as each completed step.
> Read this first in every new session.

## Current status
- **Phase:** 0 (Foundation)
- **Next step:** Phase 1 (after owner approval)
- **State:** Phase 0 complete, awaiting owner approval

## Phases
| # | Phase | Status |
|---|---|---|
| 0 | Foundation | 🔨 In progress |
| 1 | Auth + notebooks + first deploy | ⏳ Not started |
| 2 | Sources (no processing) | ⏳ Not started |
| 3 | Ingestion pipeline | ⏳ Not started |
| 4 | Eval foundation | ⏳ Not started |
| 5 | Basic RAG chat | ⏳ Not started |
| 6 | Advanced retrieval | ⏳ Not started |
| 7 | Memory | ⏳ Not started |
| 8 | Learning paths | ⏳ Not started |
| 9 | Lessons | ⏳ Not started |
| 10 | Hardening | ⏳ Not started |
| 11 | Final evals + polish | ⏳ Not started |

Status values: ⏳ Not started · 🔨 In progress · ✅ Done (owner approved)

## Current phase steps: Phase 0
- [x] 0.1 Root: pnpm workspace, tsconfig, ESLint + Prettier, .gitignore, .env.example
- [x] 0.2 packages/shared: Zod, error codes, error + pagination schemas
- [x] 0.3 apps/server: Express 5, pino, helmet, CORS, error handler, /health
- [x] 0.4 config/: env validation, limits, models, feature flags
- [x] 0.5 Drizzle + Neon: pooled connection, drizzle-kit, vector extension migration
- [x] 0.6 Vitest on Neon test branch; /health test
- [x] 0.7 apps/web: Next.js, Tailwind, shadcn/ui, TanStack Query, API client

## Accounts & keys
| Service | Needed in phase | Status |
|---|---|---|
| Neon | 0 | ✅ Project `curio` (`red-forest-65860222`), branches `main` / `dev` / `test` |
| Clerk | 1 | ⬜ Not set up |
| Vercel | 1 | ⬜ Not set up |
| Cloudflare R2 | 2 | ⬜ Not set up |
| Inngest | 3 | ⬜ Not set up |
| OpenAI | 3 | ⬜ Not set up |
| Firecrawl | 3 | ⬜ Not set up |
| Transcript API | 3 | ⬜ Not set up |
| Langfuse | 5 | ⬜ Not set up |
| Upstash | 5 | ⬜ Not set up |
| Cohere / Jina | 6 | ⬜ Not set up |
| Tavily | 8 | ⬜ Not set up |

## Blockers
- None

## Eval results so far
- None yet (baseline comes in Phase 4)

## Session log
<!-- Newest first. One entry per session:
### YYYY-MM-DD
- Done: steps X.Y–X.Z
- Commits: <short hashes>
- Notes: anything the next session must know
-->

### 2026-09-28
- Done: repo setup (private GitHub `rohhitrz/curio`), steps 0.1–0.7 (Phase 0 complete, awaiting approval)
- Notes: TypeScript pinned to `~6.0` because typescript-eslint 8.x doesn't support TS 7 yet; revisit when it does. Root `.env` holds all env vars (`.env.example` lists Phase 0 keys only; each phase adds its own). `@curio/shared` builds to `dist/` with tsc; root `dev`/`test`/`typecheck`/`lint` build it first. Pagination max limit = 100 (API contract, lives in shared; default 20 per API doc). Server extras: `pino-http` (request logging + `x-request-id`), `tsx` (dev runner); pnpm `allowBuilds` approves `esbuild` only. `GET /health` is at the root, not under `/api/v1`. Config: LLM tasks map to tiers (`luna`/`sol`); exact OpenAI model IDs to be set + verified in step 5.2. Retrieval flags all off until Phase 6. Rate-limit windows modeled as `{limit, windowSeconds}`. DB: `@neondatabase/serverless` Pool (WebSocket, supports transactions) + Drizzle; migrations in `apps/server/src/db/migrations`, run manually with `pnpm db:migrate` (dev) / `pnpm db:migrate:test`. `vector` 0.8.6 enabled on `dev` and `test`; `main` not migrated yet (Phase 1.6). Tests: Vitest + Supertest in `apps/server`; `test/setup.ts` forces `DATABASE_URL` = `TEST_DATABASE_URL` (refuses if equal to dev), truncates all public tables before each file, files run serially. 13 tests passing. Web: Next.js 16 + Tailwind 4 + shadcn/ui (`base-nova` style, Base UI primitives, shadcn's `cn` package) + TanStack Query; API client in `apps/web/src/lib/api` (bearer token via `getToken`, stub until Clerk in 1.1; parses standard error format into `ApiError`); `next.config.ts` loads the root `.env`. 8 web unit tests passing.
