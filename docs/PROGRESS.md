# PROGRESS — Curio

> Updated by the agent in the same commit as each completed step.
> Read this first in every new session.

## Current status
- **Phase:** 3 (Ingestion pipeline), in progress
- **Current step:** 3.6 (sweeper, reprocess, content + chunks endpoints, notebook cleanup job)
- **Blocked on:** nothing for building 3.6. The live pipeline is unverified until the owner syncs the app in Inngest and adds real sources (see "Pending on owner")
- **Next step:** 3.6

## Phases
| # | Phase | Status |
|---|---|---|
| 0 | Foundation | ✅ Done (owner approved) |
| 1 | Auth + notebooks + first deploy | ✅ Done (owner approved) |
| 2 | Sources (no processing) | ✅ Done (owner approved) |
| 3 | Ingestion pipeline | 🔨 In progress |
| 4 | Eval foundation | ⏳ Not started |
| 5 | Basic RAG chat | ⏳ Not started |
| 6 | Advanced retrieval | ⏳ Not started |
| 7 | Memory | ⏳ Not started |
| 8 | Learning paths | ⏳ Not started |
| 9 | Lessons | ⏳ Not started |
| 10 | Hardening | ⏳ Not started |
| 11 | Final evals + polish | ⏳ Not started |

Status values: ⏳ Not started · 🔨 In progress · ✅ Done (owner approved)

## Current phase steps: Phase 3
- [x] 3.1 Inngest client + signed `/api/inngest` endpoint + local dev server; adding a source sends `source/created` (live, `d53cff3`)
- [x] 3.2 Extractors behind providers: `unpdf`, Firecrawl, Supadata, text; each failure classified transient or permanent with a user-facing message. Not wired into the app yet (that is 3.5)
- [x] 3.3 Chunking module (pure): `pipelines/ingestion/chunk.ts`, tokens counted with `gpt-tokenizer`
- [x] 3.4 Migration `0005_source_chunks` (applied on `dev` and `test`; **not on `main` yet**); OpenAI embeddings provider (batched)
- [x] 3.5 `processSource` job: 4 Inngest steps (mark processing → extract → chunk → embed + atomic commit), idempotent, classified failures, stops when the source is gone (live)
- [ ] 3.6 Sweeper cron · `reprocess` · `content` + `chunks` endpoints · `notebook/deleted` R2 cleanup job
- [ ] 3.7 Frontend: failure reason + retry, text source viewer, chunk viewer

## Resume here: Phase 3
1. 3.5 is deployed (2026-09-30). The owner syncs the app in Inngest (see "Pending on owner") and adds one source of each type on the live app. This is the **first real run** of the OpenAI embeddings call and of the whole pipeline; watch the Vercel logs for `source failed`.
2. Build 3.6 → 3.7. Read `docs/05-build-plan.md` §6 and the docs each step touches.
3. Tests use fake providers only; no real API calls outside `pnpm eval`.

## Pending on owner
- **Now:** Inngest dashboard (Production environment) → Apps → Sync new app → `https://curio-server-ten.vercel.app/api/inngest`. It should now show the `process-source` function. If it reports a signature error, the signing key on Vercel doesn't match that environment's key.
- **Then verify live:** add a PDF, a website, a YouTube video and a text note; each should reach `READY`.
- **Optional:** the Inngest, OpenAI, Firecrawl and transcript keys are on Vercel for **Production only**. Preview deployments of `curio-server` won't boot until they are also ticked for Preview (we only deploy from `main`, so nothing is affected today).

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
| Inngest | 3 | 🔶 Keys in local `.env` and on Vercel (Production only); app sync waits for 3.5 (Inngest rejects an app with 0 functions) |
| OpenAI | 3 | 🔶 Key in local `.env` and on Vercel (Production); never called for real yet |
| Firecrawl | 3 | ✅ Key in local `.env` (works, smoke-tested) and on Vercel (Production) |
| Supadata (transcripts) | 3 | ✅ Key in local `.env` (`TRANSCRIPT_API_KEY`, works, smoke-tested) and on Vercel (Production) |
| Langfuse | 5 | ⬜ Not set up |
| Upstash | 5 | ⬜ Not set up |
| Cohere / Jina | 6 | ⬜ Not set up |
| Tavily | 8 | 🔶 Key already in local `.env` (`TAVILY_API_KEY`); unused until Phase 8 |

## Blockers
- None

## Working agreements (owner-approved)
- **The agent pushes** after every committed step, including pushes to `main`. Every push auto-deploys both Vercel projects. After pushing, check the new deployment is healthy.
- **Secrets:** the agent never reads or prints secret values from `.env`. It checks names only (e.g. mask with `sed`). The owner pastes secret env vars into Vercel; the agent sets non-secret ones via the Vercel connector.
- **The production database is not read by the agent.** The owner checks Neon `main` in the console. Migrations on `main` run manually: `cd apps/server && pnpm db:migrate:prod`.
- **Direct production deploys** (Vercel "create deployment" / Redeploy) are the owner's to click; a git push is the normal way to deploy.
- **Vercel env values are stored literally.** Paste without the quotes used in `.env`; quoted values broke `DATABASE_URL` once.

## Environments & runbook
- **Vercel type-checks `curio-server` differently from `tsc`:** its Node builder reads `apps/server/tsconfig.json` alone and, since `module` isn't set in that file, forces `strict: false` and target ES2021; it checks file by file from the entrypoint; and some globals (fetch's `Response`) come out empty. Code can pass `pnpm typecheck` and fail the deploy (a failed build leaves the previous deployment serving). **Before pushing server code run `pnpm --filter @curio/server typecheck:vercel`** (`scripts/vercel-typecheck.cjs` replicates the builder). Hit twice in 3.5: Inngest's `step.run` return type (fixed by parsing step results with Zod) and `Response.ok` (fixed with our own `HttpResponse` type in `lib/http-request.ts`).
- **Formatting:** run Prettier from the **repo root** (`pnpm format`, or `npx prettier --write <path>` there). Run from `apps/server` it ignores the root `.prettierignore` and reformats the Drizzle migration snapshots. After a failed `pnpm --filter @curio/server build`, check `git status` for stray `.js` files under `apps/server/test` before `git add`.
- **Local jobs:** `pnpm dev:inngest` runs the Inngest dev server (UI on :8288) against `:4000/api/inngest`; `.env` has `INNGEST_DEV=1`, so the API sends events there and skips signatures. It polls the endpoint every 5 s (`PUT /api/inngest` in the API log is that). `.claude/launch.json` has an `inngest` config for it.
- **Local:** `pnpm dev` (web :3000, API :4000; CORS only allows :3000). `.claude/launch.json` runs it with `autoPort: false`; it's untracked local tooling. Known quirk: the preview tool injects `PORT=3000` into the whole process, so the API also binds 3000 and the web app can't reach it. For API checks, run the server alone.
- **Local DB** = Neon `dev` (`DATABASE_URL`). **Tests** = Neon `test` (`TEST_DATABASE_URL`). `test/helpers/db.ts` `assertSafeTestDatabase` refuses when its host + database (ignoring `-pooler`, credentials, params) matches `DATABASE_URL`, `DATABASE_URL_UNPOOLED` or `PROD_DATABASE_URL`, at setup and before every truncate. Tables are truncated per file; files run serially. **Prod** = Neon `main`.
- **Migrations:** `pnpm db:generate --name=<x>` then `pnpm db:migrate` (dev) · `pnpm db:migrate:test` · `pnpm db:migrate:prod` (main). `drizzle.config.ts` maps `DB_TARGET` dev/test/prod explicitly and fails on unknown targets. Current: `0000_enable_vector`, `0001_users`, `0002_topics_notebooks`, `0003_sources` applied on all three branches; `0004_sources_storage_key_unique` on all three (prod run by the owner, 2026-09-30); `0005_source_chunks` on all three (prod run by the owner, 2026-09-30); `0006_sources_extracted_locations` on all three (prod run by the owner, 2026-09-30). The agent can't verify production; both prod runs are as reported by the owner.
- **Vercel `curio-server` env:** `DATABASE_URL` (Neon `main` pooled), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `NODE_ENV=production`, `CORS_ORIGINS=https://curio-web-theta.vercel.app` (Production + Preview, 2026-09-30), `LOG_LEVEL=info`, `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` + `OPENAI_API_KEY` + `FIRECRAWL_API_KEY` + `TRANSCRIPT_API_KEY` (Secret, Production only; all five are required at boot), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=curio-prod`. The server always reads `DATABASE_URL`; `PROD_DATABASE_URL` exists only in local `.env` for migrations.
- **Vercel `curio-web` env:** `NEXT_PUBLIC_API_URL=https://curio-server-ten.vercel.app`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, sign-in/up URLs.
- **Projects:** root dirs `apps/server` / `apps/web`, Node 22.x, Vercel Authentication on **preview only** (production URLs are public). Preview URLs aren't in `CORS_ORIGINS`, so previews can't reach the API.

## Decisions & conventions not (yet) in the design docs
Tooling and stack:
- **TypeScript is pinned to `~6.0`** because typescript-eslint 8.x doesn't support TS 7. Revisit when it does.
- **Server extras:** `pino-http` (request logs + `x-request-id`), `tsx` (dev runner), `pino-pretty` (dev). pnpm `allowBuilds` approves `esbuild` only.
- **Driver:** `@neondatabase/serverless` Pool (WebSocket, so interactive transactions work) with Drizzle.
- **Web query cache is per user:** `providers.tsx` + `lib/user-cache.ts`. A real user change (sign-out, account switch) gets a fresh `QueryClient` **and remounts the provider subtree** (`key={generation}`), because `useQuery` stays bound to the client it first saw. Clerk resolving the user for the first time is not a change and keeps the client.
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
- **Unreadable bodies** (too large, bad charset/encoding, malformed JSON, aborted) → 400 `VALIDATION_ERROR`, never 500. 400 rather than 413/415 because the API doc's status table has neither.
- **`CORS_ORIGINS` is required** and every entry must be a bare origin (no path or trailing slash). An empty list used to boot and disable Clerk's `authorizedParties` check.
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
  - **One upload → one source:** `UNIQUE (storage_key)` plus an in-transaction check. Reusing a key (same or other notebook) → 400 `UPLOAD_NOT_FOUND` "already added as a source" (no new error code). The insert uses a bare `ON CONFLICT DO NOTHING`, then works out which constraint won (duplicate hash → 409 first).
  - **`NODE_ENV` defaults to `production`**, not `development` (which enables the dev-only `pino-pretty` and crashed non-Vercel deploys on boot).
  - **Frontend (2.5):** `features/sources/`. One add dialog with 4 tabs; PDF = SHA-256 in the browser (Web Crypto) → `POST uploads` → XHR PUT with progress (`application/pdf`, exact file) → `POST sources`. Closing the dialog aborts only hashing/upload; once the file is in R2 the source is always registered, and the list refreshes on settle (hook-level `onSettled` runs after unmount). The PDF title follows the chosen file until the user types their own (`titleAfterFileChange`). A 409 offers "Show it", which scrolls to and highlights the existing row. "Open PDF" opens the tab during the click, then sets the signed URL (avoids pop-up blocking). Polling stops when nothing is `PENDING`/`PROCESSING`. A duplicate PDF is only detected after its upload, which leaves an orphan in R2 (post-launch cleanup job). Lucide 1.x has no brand icons, so YouTube uses `SquarePlay`.
  - **Not yet:** the `POST /sources` rate limit (50/day) needs Upstash (Phase 5).
- **Jobs (3.1):**
  - `inngest` 4.x, behind `JobsProvider` in `lib/jobs` (`send(name, data)`, typed by `JobEvents`). Client ID `curio`. pnpm `allowBuilds` declines `protobufjs` (its install script only prints a version warning).
  - **Env:** `INNGEST_DEV` is `1`/`true`/`0`/`false` (unset = off). Without dev mode, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are required and the server refuses to boot. The client always gets `isDev` from our config, so the SDK never decides the mode from the environment itself.
  - **Endpoint:** `/api/inngest` is mounted before the general JSON parser with its own 4 MB limit (`requests.inngestBodyLimit`), outside `/api/v1` and user auth. In cloud mode the SDK answers unsigned or forged `GET`/`POST` with 401. An unsigned `PUT` only makes the SDK re-register this app with Inngest using our signing key (standard Inngest behavior). No functions are registered until 3.5.
  - **`source/created`** = `{ sourceId, userId }`, sent after the insert transaction commits. If the send fails, the request still returns 202 and the source stays `PENDING` (warn log `source/created not sent`); failing the request would make a retry hit 409. **Open for 3.6:** the sweeper must also pick up stale `PENDING` rows; `02-system-design.md` only mentions `PROCESSING`, so propose that doc change then.
  - Verified locally: the dev server synced the app (`PUT` 200) and received a `source/created` sent through the provider.
- **Extraction (3.2):**
  - **Layout:** providers in `lib/scraper` (Firecrawl), `lib/transcript` (Supadata), `lib/pdf` (`unpdf`); `StorageProvider.download(key)` returns the bytes or null. `pipelines/ingestion/extract.ts` `extractSource(source, deps)` picks by type and returns `{ title, content, metadata }`.
  - **Content shape** keeps each type's citation location: PDF → `pages[{ pageNumber, text }]` (empty pages kept so numbers stay right), YouTube → `segments[{ text, startSeconds, endSeconds }]`, website/text → `markdown`. How this is stored between job steps is decided in 3.5.
  - **Titles:** website and YouTube return the real title (replaces the placeholder); PDF and text return `null` and keep the user's title.
  - **Learned metadata:** PDF `pageCount` + `fileHash` (real SHA-256 of the file; the browser's hash is only a claim, and what to do on a mismatch is a 3.5 decision); YouTube `durationSeconds` + `language`.
  - **Errors:** everything thrown is an `IngestionError` (`errors/ingestion-error.ts`; renamed from `ExtractionError` in 3.4 because embedding uses it too) with `code`, `retryable` and a user-facing `message`; vendor detail goes in `cause` for the log only. **Source error codes (not in the docs yet):** `NO_TEXT`, `INVALID_FILE`, `FILE_MISSING`, `PAGE_NOT_FOUND`, `PAGE_BLOCKED`, `NO_TRANSCRIPT`, `VIDEO_UNAVAILABLE`, `VIDEO_TOO_LONG`, `SERVICE_UNAVAILABLE` (the only transient one), `PROCESSING_FAILED`, plus the sweeper's `TIMEOUT`. Propose adding the list to `04-api-design.md` when 3.7 shows them.
  - **Transient** = network failure, timeout, 429, 5xx, vendor still working. **Permanent** = the rest, including our own bad key or empty credits (401/402 → `PROCESSING_FAILED` with a generic message; retrying can't fix it).
  - **No vendor SDKs:** Firecrawl and Supadata are called with plain `fetch` (one endpoint each), so there is no new dependency beyond `unpdf` and tests inject a stub `fetch`. Timeouts and the transcript job polling are in `config/limits.ts` `extraction`.
  - **Firecrawl** `POST /v2/scrape` (markdown, main content only). It reports a failed scrape as **HTTP 200 with `success: false`** and a `code` (seen live for a DNS failure), and reports the target page's own status in `metadata.statusCode` (404/410 → `PAGE_NOT_FOUND`, 401/403 → `PAGE_BLOCKED`).
  - **Supadata** `GET /v1/metadata` (title, length) then `GET /v1/transcript?mode=native`. No captions comes back as **HTTP 206** with `error: transcript-unavailable`. A 202 means a background job, polled up to 10 × 3 s. The 3-hour limit is checked before the transcript is fetched.
  - **PDF:** type checked by content (`%PDF-` in the first 1024 bytes); no text on any page → `NO_TEXT` (scanned); unreadable or password-protected → `INVALID_FILE`.
  - **Tests that need fakes or helpers live in `test/unit/`**, not next to the source: `tsconfig.build.json` compiles `src/**` with `rootDir: src`, so a `src` test importing from `test/` breaks the build.
  - **Real smoke test (one scratch script, since deleted):** Firecrawl scraped a page, mapped a 404 page and a dead domain; Supadata returned a video's details and 61 caption segments and mapped a missing video; R2 `download` of a missing key returned null. Not exercised live: a video without captions, a password-protected PDF, R2 `download` of an existing file.
- **Chunking (3.3):**
  - `chunkContent(content, { title, targetTokens, overlapRatio, countTokens })` → `{ text, chunks }`. Pure; the job passes `config.chunking` (500 / 0.15) and `countTokens` from `pipelines/ingestion/tokens.ts` (`gpt-tokenizer`, `cl100k_base`, the encoding of `text-embedding-3-small`; owner-approved dependency).
  - **`text` is the source's full text** (what 3.5 stores in `extracted_text`): markdown as is, PDF pages joined by a blank line, caption segments joined by a space. Every chunk's `content` is an exact slice of it (`charStart`/`charEnd`), so the viewer can highlight it.
  - **Hard boundaries:** a chunk never crosses a PDF page or a markdown heading (`#`–`######`; fenced code is skipped). A transcript has none. Overlap is only applied inside a boundary.
  - **Packing:** units are sentences and lines (one caption segment for YouTube). They are packed up to the target; the chunk ends early at a paragraph break when it is at least half full and the next paragraph would not fit whole. A unit over the target is cut into word runs, and an unbroken string by length.
  - **Overlap:** the next chunk starts with the previous chunk's trailing units, up to `target × ratio` tokens (75). If the last unit alone is bigger, there is no overlap.
  - **Sizes:** the units of a chunk never add up to more than the target; `tokenCount` is measured on the final text, so it can be a few tokens higher (separators).
  - **Context header:** website/text = `Title › Heading › Subheading` (a first heading equal to the title is not repeated); PDF and YouTube = the title only (page numbers and timestamps would be noise in the embedding).
  - **Locations:** `pageNumber` (PDF), `startSeconds`/`endSeconds` floored/ceiled to whole seconds (YouTube), `headingPath` (website/text; null before the first heading).
  - **Tuning points for Phase 6:** small sections each become their own small chunk (no merging across headings); only ATX headings count.

- **Chunks table + embeddings (3.4):**
  - `source_chunks` matches `03-database-design.md`: `vector(1536)` (from `config.embeddings.dimensions`), `search_vector` generated by Postgres from the context header + content, `UNIQUE (source_id, chunk_index)`, HNSW (`vector_cosine_ops`), GIN and `notebook_id` indexes, cascade from `sources`. The iterative-scan setting belongs to the search query (4.1), not the table.
  - **Embeddings provider** (`lib/embeddings`): `embed(texts)` → one vector per text in order, plus `model` for `sources.embedding_model`. Plain `fetch` to `POST /v1/embeddings` (no SDK), `config.embeddingRequests.batchSize` (100) texts per call, batches in sequence; a failed batch fails the whole call. 429 / 5xx / timeout → transient; `insufficient_quota`, 400, 401, 404 → permanent `PROCESSING_FAILED`.
  - **Not called for real:** only `pnpm eval` may call OpenAI, so the provider is covered by stubbed-`fetch` tests only. Its first real call will be the 3.5 end-to-end check.
  - Test fake: `test/fakes/embeddings.ts` gives each text a stable unit vector.

- **`processSource` job (3.5):**
  - **Layers:** `inngest/process-source.ts` (the Inngest function, thin) → `services/ingestion.service.ts` (one method per step) → `repositories/ingestion.repository.ts`. Everything is scoped by `userId` + `sourceId` from the event; a job for someone else's source finds nothing.
  - **Steps:** `mark-processing` → `extract` → `chunk` → `embed-and-commit` (decision I-13; `02-system-design.md` §6 updated). Steps return only a small status; text and locations are read from and written to the database.
  - **Between steps:** `extracted_text` holds the full text and the new `sources.extracted_locations` (jsonb, migration `0006`) holds page / caption-segment lengths (`pipelines/ingestion/stored-content.ts`). Together they rebuild the extracted content exactly.
  - **Commit:** one transaction locks the source row (`FOR UPDATE`, only while `PROCESSING`), deletes its chunks, inserts the new ones in batches of `ingestion.chunkInsertBatchSize`, and sets `READY`, `chunk_count`, `embedding_model`, `processed_at`. A failure rolls everything back; a deleted source means nothing is written.
  - **Failures:** a permanent `IngestionError` marks the source `FAILED` with its code and message and ends the job without an error. A transient or unexpected error is thrown so Inngest retries the step (`ingestion.retries` = 3, with backoff); on the last attempt it marks the source `FAILED` instead (`SERVICE_UNAVAILABLE`, or `PROCESSING_FAILED` with a generic message for unexpected errors). `onFailure` is a last safety net. `PROCESSING_FAILED` is logged at error level, other failures at warn.
  - **Writes only land while the source is `PROCESSING`**, so a finished or deleted source is never touched by a late step.
  - **Titles:** a website or YouTube source gets its real title only if it still has the placeholder from when it was added; a title the user typed is kept. PDFs and text keep their title.
  - **PDF hash:** if the file's real SHA-256 differs from the registered `content_hash` → `FAILED` / `INVALID_FILE`.
  - **Failed reprocess** leaves the previous chunks in place (status `FAILED`); search must filter on `READY` sources (4.1).
  - **Limits** (`config.ingestion`): 5 runs at once in total, 2 per user, 30 run starts per minute.
  - **Embedding input** = context header + blank line + chunk content; the stored `content` is the chunk alone.
  - **Env:** `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `TRANSCRIPT_API_KEY` are now required at boot.
  - **Tests:** the service runs against Neon `test` with fake providers (and the real `unpdf`); the Inngest function runs through `@inngest/test` (dev dependency, named in the test plan). Locally the Inngest dev server registered `curio-process-source` and completed a run for a non-existent source. **Not run for real:** a full pipeline run with OpenAI, since only `pnpm eval` may call it.
  - **Known gap until 3.6:** sources added in production between the 3.1 deploy and the Inngest app sync have no job run and stay `PENDING` (the API doc forbids reprocessing a `PENDING` source). The 3.6 sweeper should pick up stale `PENDING` rows; that needs a doc change, to be proposed then.


## Eval results so far
- None yet (baseline comes in Phase 4)

## Session log
<!-- Newest first. One entry per session:
### YYYY-MM-DD
- Done: steps X.Y–X.Z
- Commits: <short hashes>
- Notes: anything the next session must know
-->

### 2026-09-30 (3.5)
- Done: 3.5 (`processSource` job, migration `0006` on `dev` + `test`, provider keys required at boot, decision I-13, docs 02/03 updated)
- Notes: 378 tests passing (344 server, 34 web). Pushed after the owner ran `0006` on production

### 2026-09-30 (3.4)
- Done: 3.4 (`source_chunks` migration on `dev` + `test`, OpenAI embeddings provider). `ExtractionError` renamed `IngestionError`; code `EXTRACTION_FAILED` renamed `PROCESSING_FAILED`
- Notes: 338 tests passing (304 server, 34 web)

### 2026-09-30 (3.3)
- Done: 3.3 (chunking module)
- Notes: 315 tests passing (281 server, 34 web)

### 2026-09-30 (3.2)
- Done: 3.2 (extractors for all 4 types behind providers, classified errors, decision I-12 = Supadata)
- Notes: 289 tests passing (255 server, 34 web). Inngest Cloud would not sync the app yet (0 functions); retry after 3.5

### 2026-09-30 (Phase 3 start)
- Done: 3.1 (Inngest client, signed `/api/inngest`, `dev:inngest`, `source/created` on source creation)
- Notes: 218 tests passing (184 server, 34 web). Held back until the owner added the two Inngest keys to Vercel, then pushed; both deployments `READY`, `/health` 200, unsigned `/api/inngest` → 401
- Commits: `d53cff3`

### 2026-09-30 (Phase 2 approved)
- Owner approved Phase 2. `.env.example` lists the Phase 3 key names; Phase 3 starts in a new session once the keys are in `.env`

### 2026-09-30 (browser verification)
- Done: signed-in browser run of Phase 2 (see "Resume here"). Found and fixed a bug in the per-user cache fix: the notebook header's source count never updated, because the first `userId` report swapped the `QueryClient` and already-mounted queries stayed on the old one
- Notes: 205 tests passing (171 server, 34 web). Leftover in `curio-dev`: a 12.7 MB upload from 2026-09-29 under user `7226501d…` (likely an orphan from earlier manual testing)

### 2026-09-30 (review fixes 2)
- Done: 4 owner-reported fixes: one upload per source (migration 0004 + app check); PDF title follows the chosen file; cancel no longer hides a source or orphans a file; `NODE_ENV` defaults to production
- Notes: 200 tests passing (171 server, 29 web). Owner ran `0004` on production

### 2026-09-30
- Done: 2.5 (sources panel, add dialog for 4 types, browser SHA-256, direct upload + progress, status badges, polling, rename/delete/open)
- Notes: 193 tests passing (168 server, 25 web). Not clicked through locally (no signed-in session); owner verifies live. `.claude/launch.json` now also has separate `api` (:4000) and `web` (:3000) configs, which avoid the `PORT=3000` quirk

### 2026-09-29 (session 2, review fixes)
- Done: 4 owner-reported fixes before 2.5: body-parser errors → 400; `CORS_ORIGINS` required + validated; stronger test-DB guard; per-user query cache in the web app
- Commits: `f0010d1`, `6a2c5c8`, `d8a607f`, `15e1936`
- Notes: 181 tests passing (168 server, 13 web). The web fix is covered by typecheck/build and a signed-out render check only; an account switch wasn't clicked through (it needs a real Clerk sign-in)

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
