# PROGRESS — Curio

> Updated by the agent in the same commit as each completed step.
> Read this first in every new session.

## Current status
- **Phase:** 1 (Auth + notebooks + first deploy)
- **Next step:** 1.6
- **State:** In progress

## Phases
| # | Phase | Status |
|---|---|---|
| 0 | Foundation | ✅ Done (owner approved) |
| 1 | Auth + notebooks + first deploy | 🔨 In progress |
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

## Current phase steps: Phase 1
- [x] 1.1 Frontend Clerk: sign-in/sign-up, protected routes
- [x] 1.2 Backend auth middleware: verify token → create user on first request → attach `userId`
- [x] 1.3 Migration: `users`, `topics`, `notebooks`
- [x] 1.4 Notebooks API (5 endpoints), full layering + cursor pagination helper
- [x] 1.5 Frontend: notebooks list, create, rename, delete
- [ ] 1.6 Deploy: two Vercel projects, env vars, CORS for real domain, Neon `main`, manual migration script

## Accounts & keys
| Service | Needed in phase | Status |
|---|---|---|
| Neon | 0 | ✅ Project `curio` (`red-forest-65860222`), branches `main` / `dev` / `test` |
| Clerk | 1 | ✅ App `curio` (development instance), keys in `.env` |
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
- Done: repo setup (private GitHub `rohhitrz/curio`), steps 0.1–0.7; Phase 0 approved by owner
- Notes: TypeScript pinned to `~6.0` because typescript-eslint 8.x doesn't support TS 7 yet; revisit when it does. Root `.env` holds all env vars (`.env.example` lists Phase 0 keys only; each phase adds its own). `@curio/shared` builds to `dist/` with tsc; root `dev`/`test`/`typecheck`/`lint` build it first. Pagination max limit = 100 (API contract, lives in shared; default 20 per API doc). Server extras: `pino-http` (request logging + `x-request-id`), `tsx` (dev runner); pnpm `allowBuilds` approves `esbuild` only. `GET /health` is at the root, not under `/api/v1`. Config: LLM tasks map to tiers (`luna`/`sol`); exact OpenAI model IDs to be set + verified in step 5.2. Retrieval flags all off until Phase 6. Rate-limit windows modeled as `{limit, windowSeconds}`. DB: `@neondatabase/serverless` Pool (WebSocket, supports transactions) + Drizzle; migrations in `apps/server/src/db/migrations`, run manually with `pnpm db:migrate` (dev) / `pnpm db:migrate:test`. `vector` 0.8.6 enabled on `dev` and `test`; `main` not migrated yet (Phase 1.6). Tests: Vitest + Supertest in `apps/server`; `test/setup.ts` forces `DATABASE_URL` = `TEST_DATABASE_URL` (refuses if equal to dev), truncates all public tables before each file, files run serially. 13 tests passing. Web: Next.js 16 + Tailwind 4 + shadcn/ui (`base-nova` style, Base UI primitives, shadcn's `cn` package) + TanStack Query; API client in `apps/web/src/lib/api` (bearer token via `getToken`, stub until Clerk in 1.1; parses standard error format into `ApiError`); `next.config.ts` loads the root `.env`. 8 web unit tests passing. Phase 1.1: `@clerk/nextjs` 7 via manual quickstart (Clerk CLI login failed with a server-side OAuth error). Skipped `@clerk/ui` shadcn theme (pulls a Solana wallet stack); Clerk styled via `appearance.variables` mapped to our CSS tokens. `createRouteMatcher` is deprecated: `src/proxy.ts` is plain `clerkMiddleware()`, and the `(app)` route group layout calls `auth.protect()`. Base UI `Button` rendering a `Link` needs `nativeButton={false}`. Owner signed up as first test user. Phase 1.2: `users` table + migration moved into 1.2 (auth creates the row, so it can't wait for 1.3); 1.3 adds `topics` + `notebooks`. `AuthProvider` in `lib/auth` (Clerk via `@clerk/express` `clerkMiddleware` + `getAuth`, `authorizedParties` = CORS origins; test provider = `Bearer test_<clerkUserId>`, throws unless `NODE_ENV=test`). `requireAuth` on the `/api/v1` router; user get-or-create is select → insert on conflict do nothing → reselect. Real signed-in token E2E deferred to 1.5. Phase 1.3: `topics` (HNSW cosine on embedding) + `notebooks` (`notebook_kind` enum, `(user_id, updated_at DESC)` index) migrated on `dev` + `test`. Phase 1.4: 5 notebook endpoints (route → controller → service → repository). Keyset cursor = base64url `{t, i}` with `updated_at` as microsecond text (JS Date would lose precision → dup/gap); order `updated_at DESC, id DESC`. Title 1–200 chars trimmed (`NOTEBOOK_TITLE_MAX` in shared). 30-notebook quota enforced in a transaction with a per-user advisory lock. Malformed notebook ID → 404. `GET` detail counts return 0 / `learningPathId: null` until Phases 2/5/8 add the tables. Phase 1.5: notebooks UI in `apps/web/src/features/notebooks` (infinite list + Load more, create/rename dialog validated with the shared Zod schema, delete confirm, detail page at `/notebooks/[id]`). Owner verified CRUD signed in with a real Clerk token; dev DB shows the user row created on first request. ESLint `no-confusing-void-expression` set to `ignoreArrowShorthand` for React handlers. Phase 1.6 prep: `apps/server/src/index.ts` default-exports the app for Vercel and only listens when `VERCEL` is unset; `createApp` moved to `create-app.ts` so Vercel can't pick it as the entrypoint. `vercel-build` scripts build `@curio/shared` first. `pnpm db:migrate:prod` (`DB_TARGET=prod`, `PROD_DATABASE_URL`) migrates Neon `main`, run manually. First attempt silently hit `dev` (a config edit didn't apply); fixed `drizzle.config.ts` to map dev/test/prod explicitly and fail on unknown targets, then migrated `main` 2026-09-28.
