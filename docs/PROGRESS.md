# PROGRESS — Curio

> Updated by the agent in the same commit as each completed step.
> Read this first in every new session.

## Current status
- **Phase:** 2 (Sources, no processing)
- **Current step:** 2.5 (frontend sources panel)
- **Blocked on:** nothing
- **Next step:** 2.5 (see "Resume here"). It's the last step of Phase 2, so stop for owner approval after it

## Phases
| # | Phase | Status |
|---|---|---|
| 0 | Foundation | ✅ Done (owner approved) |
| 1 | Auth + notebooks + first deploy | ✅ Done (owner approved) |
| 2 | Sources (no processing) | 🔨 In progress |
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

## Current phase steps: Phase 2
- [x] 2.1 Migration: `sources` (applied on `dev`, `test`, and `main`)
- [x] 2.2 R2 provider: signed PUT/GET URLs, existence check, delete. Smoke-tested on both real buckets; required `R2_*` env vars; provider passed into `createApp`
- [x] 2.3 `POST /notebooks/:id/uploads` + `POST /notebooks/:id/sources` (discriminated union), URL normalization, YouTube parsing, `content_hash` dedupe, quotas
- [x] 2.4 List, get, patch, delete (+ R2 delete), `file-url`
- [ ] 2.5 Frontend: sources panel, 4 add dialogs, browser SHA-256, direct upload + progress, status badges, polling

## Resume here: 2.5
2.4 is done; all Phase 2 API endpoints are live. For 2.5 (frontend): sources panel on the notebook page, 4 add dialogs, SHA-256 in the browser (Web Crypto), `POST .../uploads` → PUT to R2 with progress (XHR, same `Content-Type` + size) → `POST .../sources`, status badges, polling `GET /notebooks/:id/sources` every ~2s while any source is `PENDING`/`PROCESSING`. Handle 409 via `details.existingSourceId`. Then verify on the live URL (Phase 2 "done when": all 4 types sit in `PENDING`, duplicates → 409, PDF lands under the user prefix in `curio-prod`) and stop for approval.

## Pending on owner
- Nothing right now.

## R2 setup (done 2026-09-29)
- Private buckets `curio-dev` (local, `.env`) and `curio-prod` (Vercel `curio-server`, Production + Preview). One Object Read & Write token per bucket, each scoped to its own bucket. Local `.env` also keeps the prod keys as `R2_ACCESS_KEY_ID_PROD` / `R2_SECRET_ACCESS_KEY_PROD`; the app ignores those names.
- Bucket CORS: GET + PUT, `Content-Type` header only, one origin each:
  - `curio-dev`: `http://localhost:3000`
  - `curio-prod`: `https://curio-web-theta.vercel.app`
- Both buckets passed a real smoke test (scratchpad script, since deleted): wrong Content-Type → 403, wrong length → 403, PUT → 200, head size/type, GET bytes match, CORS preflight allowed for the bucket's origin and denied for others, delete → head null, deleting a missing key is fine.

## Accounts & keys
| Service | Needed in phase | Status |
|---|---|---|
| Neon | 0 | ✅ Project `curio` (`red-forest-65860222`): `main` = production, `dev` = local, `test` = tests |
| Clerk | 1 | ✅ App `curio` (**development** instance, used locally and in production) |
| Vercel | 1 | ✅ Team `rohits-projects-f028bcc9` (`team_mJhVwylbdaoL6ox7AYfde7uf`): `curio-web` → https://curio-web-theta.vercel.app · `curio-server` → https://curio-server-ten.vercel.app |
| Cloudflare R2 | 2 | ✅ `curio-dev` (local) and `curio-prod` (live), one token each (see "R2 setup") |
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

## Working agreements (owner-approved)
- **The agent pushes** after every committed step, including pushes to `main`. Every push auto-deploys both Vercel projects. After pushing, check the new deployment is healthy.
- **Secrets:** the agent never reads or prints secret values from `.env`. It checks names only (e.g. mask with `sed`). The owner pastes secret env vars into Vercel; the agent sets non-secret ones via the Vercel connector.
- **The production database is not read by the agent.** The owner checks Neon `main` in the console. Migrations on `main` run manually: `cd apps/server && pnpm db:migrate:prod`.
- **Direct production deploys** (Vercel "create deployment" / Redeploy) are the owner's to click; a git push is the normal way to deploy.
- **Vercel env values are stored literally.** Paste without the quotes used in `.env`; quoted values broke `DATABASE_URL` once.

## Environments & runbook
- **Local:** `pnpm dev` (web :3000, API :4000; CORS only allows :3000). `.claude/launch.json` runs it with `autoPort: false`; it's untracked local tooling.
- **Local DB** = Neon `dev` (`DATABASE_URL`). **Tests** = Neon `test` (`TEST_DATABASE_URL`; `test/setup.ts` refuses if it equals dev, truncates all tables per file, runs files serially). **Prod** = Neon `main`.
- **Migrations:** `pnpm db:generate --name=<x>` then `pnpm db:migrate` (dev) · `pnpm db:migrate:test` · `pnpm db:migrate:prod` (main). `drizzle.config.ts` maps `DB_TARGET` dev/test/prod explicitly and fails on unknown targets. Current: `0000_enable_vector`, `0001_users`, `0002_topics_notebooks`, `0003_sources` applied on all three branches.
- **Vercel `curio-server` env:** `DATABASE_URL` (Neon `main` pooled), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `NODE_ENV=production`, `CORS_ORIGINS=https://curio-web-theta.vercel.app`, `LOG_LEVEL=info`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=curio-prod`. The server always reads `DATABASE_URL`; `PROD_DATABASE_URL` exists only in local `.env` for migrations.
- **Vercel `curio-web` env:** `NEXT_PUBLIC_API_URL=https://curio-server-ten.vercel.app`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, sign-in/up URLs.
- **Projects:** root dirs `apps/server` / `apps/web`, Node 22.x, Vercel Authentication on **preview only** (production URLs are public). Preview URLs aren't in `CORS_ORIGINS`, so previews can't reach the API.

## Decisions & conventions not (yet) in the design docs
Tooling and stack:
- **TypeScript is pinned to `~6.0`** because typescript-eslint 8.x doesn't support TS 7. Revisit when it does.
- **Server extras:** `pino-http` (request logs + `x-request-id`), `tsx` (dev runner), `pino-pretty` (dev). pnpm `allowBuilds` approves `esbuild` only.
- **Driver:** `@neondatabase/serverless` Pool (WebSocket, so interactive transactions work) with Drizzle.
- **Web:** Next.js 16 (`src/proxy.ts` is the middleware), Tailwind 4, shadcn/ui `base-nova` style (Base UI primitives, shadcn's `cn` package). A Base UI `Button` rendering a `Link` needs `nativeButton={false}`. `next.config.ts` loads the root `.env`.
- **Clerk:** `@clerk/nextjs` 7 via the manual quickstart (the Clerk CLI's login failed). `@clerk/ui` was skipped because it pulls a Solana wallet stack; Clerk is themed with `appearance.variables`. `createRouteMatcher` is deprecated, so the proxy is plain `clerkMiddleware()` and the `(app)` layout calls `auth.protect()`. Still on dev keys, because a production instance needs a custom domain.
- **`@curio/shared`** builds to `dist/`. Root `dev`/`test`/`typecheck`/`lint` build it first; Vercel builds use `vercel-build` scripts that do the same.
- **ESLint:** `strictTypeChecked`; `no-confusing-void-expression` has `ignoreArrowShorthand` for React handlers.

API and server:
- **`GET /health`** sits at the root, not under `/api/v1`.
- **Pagination:** default 20 (API doc), **max 100** (our choice), in shared.
- **Keyset cursor:** base64url `{t, i}`, with `updated_at` as microsecond text (a JS `Date` loses precision and would cause duplicates or gaps). Order is `updated_at DESC, id DESC`. A tampered cursor → 400.
- **Notebook title:** 1–200 chars, trimmed (`NOTEBOOK_TITLE_MAX`).
- **Notebook quota:** enforced in a transaction with a per-user advisory lock.
- **Malformed IDs** in paths → 404, not 400.
- **`GET /notebooks/:id` counts:** `sourceCount` is real (2.4); `conversationCount` is 0 and `learningPathId` null until Phases 5 and 8.
- **Auth:** `AuthProvider` in `lib/auth` (Clerk `clerkMiddleware` + `getAuth`, `authorizedParties` = CORS origins). The test provider uses `Bearer test_<clerkUserId>` and throws unless `NODE_ENV=test`. User get-or-create is select → insert on conflict do nothing → reselect.
- **Build-plan ordering:** the `users` table was created in 1.2, not 1.3, because auth creates the row.
- **Server entry:** `src/index.ts` default-exports the app for Vercel and only listens when `VERCEL` is unset. `createApp` lives in `create-app.ts`, so Vercel can't mistake it for the entrypoint.
- **helmet:** Vercel's build type-checks it via its CJS types, so `middleware/security-headers.ts` resolves the function in both ESM and CJS shapes. Don't import `helmet` directly.
- **Config:** LLM tasks map to tiers (`luna`/`sol`); exact model IDs get set and verified in step 5.2. Retrieval flags stay off until Phase 6. Rate limits are modeled as `{limit, windowSeconds}`.
- **Uploads path:** `POST /notebooks/:id/uploads` (the API doc path; the build plan's `/uploads` is shorthand).
- **Storage (2.2):**
  - AWS SDK v3 with checksums `WHEN_REQUIRED` (decision A-10).
  - The signed PUT binds Content-Type and Content-Length, so the browser must upload exactly the declared file. The presigner drops Content-Type unless it is passed in `signableHeaders`; `storage-r2-signing.test.ts` guards this.
  - Upload URL TTL is 10 min and download URL TTL is 5 min (`config/limits.ts` `uploads`).
  - Upload rules (`services/upload-rules.ts`): only `application/pdf` (case-insensitive), max `quotas.pdfMaxBytes`. The key is `users/{userId}/uploads/{uuid}.pdf`, checked by a strict ownership regex.
  - Shared schemas: `createUploadSchema` doesn't cap size, so the API can return `FILE_TOO_LARGE` rather than `VALIDATION_ERROR`.
- **Sources (2.3):**
  - **Dedupe hashes** (`services/source-identity.ts`): WEBSITE = SHA-256 of the normalized URL (lowercase host, no `www.`, no default port/fragment/trailing slash, `utm_*` and click IDs dropped, query sorted; **path case kept**). YOUTUBE = SHA-256 of `https://www.youtube.com/watch?v={id}` (`watch`, `youtu.be`, `shorts`, `embed`, `live`, `v`; `m.`/`music.` hosts). TEXT = SHA-256 of the trimmed text with `\n` line endings. PDF = the browser's SHA-256, lowercased.
  - **What's stored:** WEBSITE keeps the user's URL (normalization is for hashing only; stripping `www` can break fetching). YOUTUBE stores the canonical URL + `metadata.videoId`. TEXT content goes in `extracted_text`. PDF gets `metadata.fileSize` from R2 `head`.
  - **Placeholder titles** until the Phase 3 job reads the real one: WEBSITE = normalized URL without the scheme; YOUTUBE = `YouTube video {id}`.
  - **Order of checks:** notebook ownership (404) → type rules (upload key/R2, text length) → one transaction that locks the notebook row (`FOR NO KEY UPDATE`), checks duplicate (409) then quota (400), and inserts with `ON CONFLICT DO NOTHING` as a backstop. Duplicate is checked before quota.
  - **Text over 100k chars** → `QUOTA_EXCEEDED` (the test plan lists text length under quotas). The JSON body cap is raised to 1 MB (`config/limits.ts` `requests`) because 100k multi-byte chars exceed Express's 100 KB default.
  - **R2 failures** → 503 `SERVICE_UNAVAILABLE` (the cause is kept and logged; the error handler now logs every 5xx `AppError`).
  - **2.4 choices** (docs don't specify): `PATCH /sources/:id` edits `title` only (strict body). `GET /notebooks/:id/sources` returns `{ items, nextCursor: null }` (bounded, oldest first). `file-url` on a non-PDF source → 404 "This source has no file". Delete removes the row first, then R2; an R2 failure still returns 204 and logs `orphaned upload` at warn. `toSource` lists fields explicitly so `storageKey` never leaks.
  - **Not yet:** the `POST /sources` rate limit (50/day) needs Upstash (Phase 5). No `source/created` event until Phase 3.

## Eval results so far
- None yet (baseline comes in Phase 4)

## Session log
<!-- Newest first. One entry per session:
### YYYY-MM-DD
- Done: steps X.Y–X.Z
- Commits: <short hashes>
- Notes: anything the next session must know
-->

### 2026-09-29 (session 2, 2.4)
- Done: 2.4 (list, get, rename, delete + R2 delete, `file-url`, real `sourceCount`)
- Notes: 166 tests passing (153 server, 13 web)

### 2026-09-29 (session 2, cont.)
- Done: 2.3 (`POST /notebooks/:id/uploads`, `POST /notebooks/:id/sources`, dedupe, quotas). API doc: `DUPLICATE_SOURCE` carries `details.existingSourceId` (owner-approved)
- Notes: 152 tests passing (139 server, 13 web). The sources integration file takes ~3 min against Neon `test`

### 2026-09-29 (session 2)
- Done: 2.2 complete. Real smoke tests on `curio-dev` and `curio-prod`; fixed Content-Type not being signed on upload URLs (`7cf1d55`); R2 env vars required and provider wired into `createApp`
- Notes: 83 tests passing (70 server, 13 web). `R2_ACCOUNT_ID` is validated as 32-char hex

### 2026-09-29
- Done: 2.2 partial (storage interface, R2 provider, fake, upload rules; A-10 + stack table; `.env.example` gets `PROD_DATABASE_URL` + R2 vars)
- Commits: `9c70acd`, plus this handoff commit
- Notes: 80 tests passing (67 server, 13 web). The `9c70acd` deployment is healthy in production. The R2 provider has only run against the fake so far.

### 2026-09-28
- Done: repo setup (private GitHub `rohhitrz/curio`); Phase 0 (0.1–0.7, approved); Phase 1 (1.1–1.6, approved, live); 2.1
- Commits: `1a5894d` … `ed64612`
- Notes:
  - **Deploy lessons:**
    - The first `db:migrate:prod` silently hit dev because an edit didn't apply. Verify config edits.
    - The Vercel `DATABASE_URL` was first the dev string, then renamed, then quoted. The startup env validation caught each one.
    - Clicking Redeploy on an old failed deployment rebuilds the old commit.
  - **Verified live:** `/health` 200; no/forged token → 401; CORS only for the web origin; security headers present; owner CRUD writes to Neon `main`; a second account gets "Notebook not found" (404) on the first account's notebook.
  - **Leftover local process:** a `tsx watch` API process from this session may still hold port 4000 (PIDs 47138/64300 at the time). If `pnpm dev` complains, stop it.
