# Curio — Build Plan (v1)

> **Status:** Approved
> **Based on:** `01-prd.md` → `04-api-design.md` (all approved)
> **Who follows it:** Claude Code, with the owner approving each phase

---

## 1. Rules for the agent

**Before starting any work**
- Read `CLAUDE.md`, then `docs/PROGRESS.md`, then the docs relevant to the current phase
- **Work only on the current phase.** Never start the next phase without the owner's approval.

**Every step**
1. Build the step
2. Write/run its tests (per `06-test-plan.md`), and **all tests must pass**
3. Run lint + typecheck
4. **Commit** with a Conventional Commits message, e.g. `feat(sources): add PDF upload flow`, then **push**
   - Use the owner's existing git setup; never change git config
   - **No Claude co-author, no Claude attribution**
5. Update `docs/PROGRESS.md` **in the same commit**

**Stop and ask the owner when**
- A phase is complete (show what was built + how to verify it)
- An API key or external account is needed; **never invent or placeholder keys**
- A design doc seems wrong or incomplete; **update the doc first, with approval, then the code**
- A step marked **🛑 STOP** is reached

**Design rules**
- Follow the layering: `Route → Controller → Service → Repository → DB`; external services only through `lib/` providers
- All limits, model names, and feature flags come from `config/`, never hardcoded
- Pipeline logic (chunking, fusion, cut rules, citation check) as **pure functions**, so they're easy to unit test

---

## 2. Phase overview

| # | Phase | Result |
|---|---|---|
| 0 | Foundation | Monorepo runs locally, `/health` works |
| 1 | Auth + notebooks + first deploy | Sign in, notebooks CRUD, **live on Vercel** |
| 2 | Sources (no processing) | Add all 4 types, stay `PENDING` |
| 3 | Ingestion pipeline | Sources become `READY` / `FAILED` |
| 4 | Eval foundation | Baseline retrieval numbers |
| 5 | Basic RAG chat | Streaming, cited chat |
| 6 | Advanced retrieval | Measured gain per technique |
| 7 | Memory | Summaries + long-term memory |
| 8 | Learning paths | Topic → path |
| 9 | Lessons | Streamed lessons + "ask about this" |
| 10 | Hardening | Production-safe |
| 11 | Final evals + polish | Resume-ready |

---

## 3. Phase 0: Foundation

**Accounts needed:** Neon (create project + `dev` and `test` branches)

| Step | Work |
|---|---|
| 0.1 | Root: pnpm workspace, base `tsconfig`, ESLint + Prettier, `.gitignore`, `.env.example` |
| 0.2 | `packages/shared`: Zod setup, error code enum (API doc §9), error + pagination schemas |
| 0.3 | `apps/server`: Express 5 + TypeScript (ESM), `pino` logger with request ID, `helmet`, CORS, global error handler + error classes, `GET /health` |
| 0.4 | `config/`: env validation with Zod (**fail fast on missing vars**), limits, model-per-task, feature flags |
| 0.5 | Drizzle + Neon: pooled connection, `drizzle-kit` config, first migration = `CREATE EXTENSION vector` |
| 0.6 | Vitest setup; tests run against the Neon `test` branch; first test for `/health` |
| 0.7 | `apps/web`: Next.js + Tailwind + shadcn/ui, TanStack Query provider, API client (adds token, parses the error format) |

**Note:** Express 5 catches errors from async route handlers natively, so no `asyncHandler` wrapper is needed (unlike the cohort roadmap).

**Done when:** `pnpm dev` runs both apps · `/health` → 200 · tests, lint, and typecheck pass

---

## 4. Phase 1: Auth + notebooks + first deploy

**Accounts needed:** Clerk, Vercel

| Step | Work |
|---|---|
| 1.1 | Frontend Clerk: sign-in/sign-up, protected routes |
| 1.2 | Backend auth middleware: verify token → create user on first request → attach `userId` |
| 1.3 | Migration: `users`, `topics`, `notebooks` |
| 1.4 | Notebooks API (5 endpoints) with full layering + cursor pagination helper. `topic` in `PATCH` comes in phase 7. |
| 1.5 | Frontend: notebooks list, create, rename, delete |
| 1.6 | **Deploy:** two Vercel projects, env vars, CORS for the real domain, Neon `main` branch, migration script (run manually, **not on server start**) |

**Done when:** sign in on the **live URL** → create/rename/delete notebooks · another user's notebook → 404 · tests pass

---

## 5. Phase 2: Sources (no processing yet)

**Accounts needed:** Cloudflare R2 (bucket + API keys)

| Step | Work |
|---|---|
| 2.1 | Migration: `sources` |
| 2.2 | R2 provider: signed PUT/GET URLs, existence check, delete |
| 2.3 | `POST /uploads` + `POST /sources` (discriminated union), URL normalization, YouTube URL parsing, `content_hash` dedupe, quotas |
| 2.4 | List, get, patch, delete (+ R2 delete), `file-url` |
| 2.5 | Frontend: sources panel, add dialogs for 4 types, browser SHA-256, direct upload with progress bar, status badges, polling |

**Done when:** all 4 types can be added and sit in `PENDING` · duplicates → 409 · PDF lands in R2 under the user's prefix · tests pass

---

## 6. Phase 3: Ingestion pipeline

**Accounts needed:** Inngest, OpenAI, Firecrawl, transcript API

| Step | Work |
|---|---|
| 3.1 | Inngest client + signed `/api/inngest` endpoint + local dev server; adding a source sends `source/created` |
| 3.2 | Extractors behind providers: `unpdf`, Firecrawl, transcript API, text; each classifies errors as **transient** or **permanent** with a human message |
| 3.3 | Chunking module (pure): structure-first, token counting, ~500 tokens / ~15% overlap, location metadata, context header |
| 3.4 | Migration: `source_chunks` (HNSW, GIN, generated `search_vector`); embeddings provider (batched) |
| 3.5 | `processSource` job: 5 steps, IDs between steps, **atomic commit**, idempotent, concurrency + throttle, "source not found" = stop |
| 3.6 | Sweeper cron · `reprocess` · `content` + `chunks` endpoints · `notebook/deleted` R2 cleanup job |
| 3.7 | Frontend: failure reason + retry button, text source viewer, chunk viewer |

**Done when:** a real PDF, website, YouTube video, and text note all reach `READY` · scanned PDF / video without transcript → `FAILED` with a clear reason · re-running a job creates no duplicate chunks · nothing stays in `PROCESSING` · tests pass

---

## 7. Phase 4: Eval foundation

| Step | Work |
|---|---|
| 4.1 | Retrieval module v0 (pure, callable without HTTP): **vector-only** search, notebook filter, iterative scan enabled |
| 4.2 | Golden dataset: ~5–8 documents (all types), LLM drafts ~40–60 Q&A + ~10 unanswerable → saved in `evals/dataset/` |
| 🛑 | **STOP: owner reviews and fixes the dataset** |
| 4.3 | Eval runner (`pnpm eval`): ingests dataset into an eval notebook, runs questions, computes **hit rate@k + MRR**, saves JSON to `evals/results/` |
| 4.4 | Run and commit the **baseline** |

**Done when:** baseline retrieval numbers committed · runner re-runs reproducibly

---

## 8. Phase 5: Basic RAG chat

**Accounts needed:** Langfuse, Upstash

| Step | Work |
|---|---|
| 5.1 | Migration: `conversations`, `messages` |
| 5.2 | LLM provider (Luna, per-task config, static prompt prefix first) + Langfuse tracing wrapper |
| 5.3 | Generation: grounded prompt, context building, `[n]` citations → citation snapshots |
| 5.4 | Chat API: conversations CRUD, messages (newest first), **streaming send** (AI SDK, send-only-new-message), Redis busy lock, continue on disconnect, retry, feedback → Langfuse |
| 5.5 | Frontend: chat UI, streaming, status events, citations → PDF viewer at page / YouTube at timestamp / text highlight, 👍 / 👎 |
| 5.6 | Eval runner: add **answer metrics** (faithfulness, correctness, citation accuracy, refusal accuracy) with Sol as judge → run the full baseline |

**Done when:** streamed, cited answers · citations open the exact spot · every request visible in Langfuse · full baseline committed · tests pass

---

## 9. Phase 6: Advanced retrieval

**Accounts needed:** reranker (Cohere and/or Jina)

**Every step ends with an eval run, results committed.**

| Step | Work |
|---|---|
| 6.1 | Feature flags wired through the pipeline (rewrite / hybrid / rerank / sub-queries) |
| 6.2 | Query understanding: one structured call → rewrite + route + sub-queries → **eval** |
| 6.3 | Keyword search + **RRF** fusion → **eval** |
| 6.4 | Rerank provider; compare Cohere vs Jina → pick → **eval** |
| 6.5 | Relevance gate; threshold tuned on the unanswerable questions → **eval** |
| 6.6 | Citation check (deterministic) |
| 6.7 | Eval-gated trials: HyDE, chunk size tuning → **kept only if they improve results**; outcome recorded in `07-decisions.md` |
| 6.8 | Timeouts on every external call + graceful degradation (rerank down → skip, etc.) |

**Done when:** the **ablation table** exists (vector → + rewrite → + hybrid → + rerank → + sub-queries) · first token < ~3s in Langfuse · tests pass

---

## 10. Phase 7: Memory

| Step | Work |
|---|---|
| 7.1 | `summarizeConversation` job (optimistic update) + context = summary + last ~10 |
| 7.2 | Topic embeddings + `PATCH /notebooks` `topic` |
| 7.3 | Migration: `memories` (checks + partial unique indexes); repository |
| 7.4 | `extractMemories` job: add / update / skip, never overwrites `USER_EDITED`, 200 cap |
| 7.5 | Memory in prompts (tone and depth only) |
| 7.6 | Memory API (4 endpoints) + memory page + "Noted" notice |

**Done when:** a long chat stays coherent · stated preferences appear as memories · user edits survive extraction · memories never appear as citations · tests pass

---

## 11. Phase 8: Learning paths

**Accounts needed:** Tavily

| Step | Work |
|---|---|
| 8.1 | Migration: `learning_paths`, `path_resources`, `concepts`, `concept_coverage`, `modules` |
| 8.2 | Tavily search provider + `prefill` endpoint (exact + related topics) |
| 8.3 | `generateLearningPath` job, part 1: gather → create notebook → ingest resources by **invoking `processSource`** for each, in parallel |
| 8.4 | Part 2: map (fan-out) → merge → consensus → order → modules → **cut rules (pure function)** → hook; `waitForEvent` for advanced branch; partial-failure rules |
| 8.5 | API: start (one transaction + `LEVEL` memory), get, branch, retry, outline, module `PATCH` |
| 8.6 | Frontend: clarify screen, progress screen, branch picker, outline with "why is this here?", skipped list, module toggles |
| 8.7 | Evals: **coverage** vs official docs + **consistency** across runs |

**Done when:** beginner, intermediate, and advanced paths all work end-to-end · a topic without official docs works · coverage + consistency numbers committed · tests pass

---

## 12. Phase 9: Lessons

| Step | Work |
|---|---|
| 9.1 | Migration: `lessons` (also adds the FK `conversations.lesson_id → lessons.id`, ON DELETE SET NULL; the column exists since 5.1); lesson pipeline (retrieval per concept → structured lesson → stream), versions, Redis lock |
| 9.2 | Lesson API: get latest, generate (stream), get version |
| 9.3 | `PUT /completion` + `UNDERSTOOD` memories (added and removed) |
| 9.4 | "Ask about this": chat filtered by the lesson's cited sources |
| 9.5 | Frontend: lesson view, regenerate, mark done, ask about this |
| 9.6 | Eval: lesson faithfulness |

**Done when:** lessons stream with citations · regenerate creates a version · marking done creates memories, un-marking removes them · "ask about this" stays scoped · tests pass

---

## 13. Phase 10: Hardening

| Step | Work |
|---|---|
| 10.1 | Rate limits (Upstash) on all 4 limited endpoints, `Retry-After` |
| 10.2 | Quota enforcement audit (file size, video length, text length, counts) |
| 10.3 | **Ownership test suite:** every endpoint called as another user → 404 |
| 10.4 | Prompt-injection check: a source containing instructions doesn't change behavior |
| 10.5 | Degradation tests: each optional step failing → answer still produced |
| 10.6 | Security review: CORS, headers, signed Inngest, private R2, no secrets in frontend |

**Done when:** all hardening tests pass on the live deployment

---

## 14. Phase 11: Final evals + polish

| Step | Work |
|---|---|
| 11.1 | Full eval run on the final pipeline; final ablation table |
| 11.2 | `README.md`: what it is, architecture diagram, key decisions, **eval results table**, setup guide |
| 11.3 | Demo notebook + demo learning path on the live app |
| 11.4 | Final check against the PRD's success metrics |
| 🛑 | **STOP: owner's final review** |

**Done when:** every PRD success metric is checked · README has real numbers · the live app is demo-ready

---

## 15. Accounts & keys by phase

| Phase | Needed |
|---|---|
| 0 | Neon |
| 1 | Clerk, Vercel |
| 2 | Cloudflare R2 |
| 3 | Inngest, OpenAI, Firecrawl, transcript API |
| 5 | Langfuse, Upstash |
| 6 | Cohere and/or Jina |
| 8 | Tavily |

The agent **stops and asks** when a phase needs a key that isn't in `.env` yet.
