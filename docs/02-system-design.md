# Curio — System Design (v1)

> **Status:** Approved
> **Based on:** `01-prd.md` (approved)
> **Rule:** every choice below has a *why*; the full reasoning goes into `07-decisions.md`

---

## 1. Architecture overview

```
                        ┌──────────────────────┐
                        │   Browser (user)     │
                        └──────────┬───────────┘
                                   │ Clerk session token
                  ┌────────────────┴────────────────┐
                  │                                 │ direct PDF upload
                  ▼                                 ▼ (signed URL)
        ┌──────────────────┐              ┌──────────────────┐
        │  apps/web        │              │  Cloudflare R2   │
        │  Next.js (UI)    │              │  (PDF files)     │
        └────────┬─────────┘              └──────────────────┘
                 │ REST + streaming (SSE)
                 ▼
        ┌──────────────────────────────────────────────┐
        │  apps/server — Express + TypeScript          │
        │  Route → Controller → Service → Repository   │
        │                       ↘ Lib (external APIs)  │
        └───┬──────────┬──────────┬──────────┬─────────┘
            │          │          │          │
            ▼          ▼          ▼          ▼
   ┌────────────┐ ┌─────────┐ ┌────────┐ ┌──────────────────────────┐
   │ Neon       │ │ Inngest │ │Upstash │ │ External APIs            │
   │ Postgres + │ │ (jobs)  │ │ Redis  │ │ OpenAI · Rerank · Tavily │
   │ pgvector   │ │         │ │(limits)│ │ Firecrawl · Transcript   │
   └────────────┘ └─────────┘ └────────┘ └──────────────────────────┘
                                   │
                        all LLM/pipeline steps traced
                                   ▼
                          ┌──────────────┐
                          │   Langfuse   │
                          └──────────────┘
```

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| **Repo** | Monorepo (pnpm workspaces) | One repo, shared types, one place for the agent to work |
| **Frontend** | Next.js + TypeScript | UI only, no business logic |
| **UI** | Tailwind CSS + shadcn/ui | Fast, consistent, accessible components |
| **Frontend data** | TanStack Query | Caching, refetching, polling source status |
| **Chat streaming** | Server-Sent Events via Vercel AI SDK (both sides) | Handles streaming UI state; works with an Express backend |
| **Answer rendering** | `react-markdown` + `remark-gfm` | Answers are Markdown; no raw HTML, `[n]` markers become citation chips |
| **Backend** | Express + TypeScript | Clean separation, portable off Vercel, matches layered pattern |
| **Shared** | `packages/shared`: Zod schemas + types | Frontend and backend validate identically, can't drift |
| **Auth** | Clerk | Token verified on every backend request |
| **Database** | Neon Postgres | Serverless, free tier, doesn't pause, branches for dev/prod |
| **Vectors** | pgvector (HNSW index) | Same DB means atomic indexing, no half-indexed sources |
| **ORM** | Drizzle | SQL-heavy queries, native pgvector support |
| **Files** | Cloudflare R2 via AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) | S3-standard, free egress; official SDK for signed URLs |
| **Jobs** | Inngest | Step-based retries, fits Vercel time limits, pause/resume |
| **Rate limits** | Upstash Redis | Shared counters across serverless instances |
| **LLM** | GPT-6 Luna (`gpt-6-luna`, default), configurable per task; Sol = GPT-6.1 Sol (`gpt-6.1-sol`) | Cheap; heavier tasks upgradable to Sol if evals demand |
| **Embeddings** | OpenAI `text-embedding-3-small` | Cheap, strong; model name stored per chunk (check for newer at build time) |
| **Reranker** | Cohere or Jina rerank API | Final pick compared in evals |
| **Web search** | Tavily | Finds resources for learning paths |
| **Scraping** | Firecrawl | Clean markdown + headings |
| **YouTube** | Supadata transcript API | Not blocked on cloud servers |
| **PDF parsing** | `unpdf` | Page-by-page text, serverless-friendly |
| **Observability** | Langfuse + `pino` logs | Per-step traces, cost, latency. Langfuse's SDK sends traces over OpenTelemetry (`@opentelemetry/sdk-node`); the AI SDK records each LLM call in the active trace |
| **Evals** | TypeScript eval runner | One language; standard metrics |
| **Hosting** | Vercel (two projects) | Frontend + backend |

---

## 3. Repository structure

```
curio/
├── CLAUDE.md
├── docs/
├── apps/
│   ├── web/                 ← Next.js frontend
│   └── server/
│       └── src/
│           ├── index.ts
│           ├── config/      ← limits, model-per-task, feature flags
│           ├── routes/
│           ├── controllers/
│           ├── services/
│           ├── repositories/
│           ├── lib/         ← providers: llm, embeddings, rerank, search, scraper, transcript, storage
│           ├── pipelines/   ← ingestion, retrieval, learning-path, lesson
│           ├── inngest/     ← job definitions
│           ├── middleware/  ← auth, rate-limit, error handler
│           └── db/          ← Drizzle schema + migrations
├── packages/
│   └── shared/              ← Zod schemas + shared types
└── evals/                   ← golden dataset, eval runner, results
```

**Layering rule:** `Route → Controller → Service → Repository → DB`. Services call `lib/` providers and `pipelines/`. Controllers never touch the DB directly.

**Provider rule:** every external service sits behind an interface in `lib/` (`LlmProvider`, `SearchProvider`, `ScraperProvider`, `RerankProvider`…). Swapping a vendor = one file.

---

## 4. Auth & data isolation

- Frontend gets a Clerk session token and sends it in the `Authorization` header
- Backend verifies it on **every** request (Clerk Express middleware)
- User row is created on the **first authenticated request**
- **Every query is scoped by `userId`**, with ownership checked in the service layer
- Another user's resource → **404** (never 403, so existence isn't leaked)

---

## 5. Data stores

**Postgres (Neon)** holds everything except files:
- Users, notebooks, sources, chunks (text + embedding + keyword index + location metadata)
- Conversations, messages, conversation summaries
- Learning paths, modules, concepts, lessons, progress
- Memories

**Key properties**
- **Chunks live next to their source**, so indexing and deletion are single transactions
- Chunks have an **HNSW vector index** and a **full-text search column** (built at insert)
- Neon **connection pooler** enabled from day one
- **Neon branches:** `dev` for local work, `main` for production
- **Tests** use a local Postgres + pgvector in Docker (`docker-compose.yml`), reached through Neon's `wsproxy` so tests run the production driver (decision PR-06). Docker is for tests only
- pgvector enabled via `CREATE EXTENSION vector;` in the first migration

**R2** holds original PDF files only.

*(Full schema → `03-database-design.md`)*

---

## 6. Ingestion pipeline

### Flow
```
API: validate → dedupe → save PENDING → send "source/created" → respond instantly
        ↓
Inngest job: processSource
  step 1  mark PROCESSING   (only a PENDING source can be claimed, so a duplicate run stops here)
  step 2  extract   → text + locations, saved to DB
  step 3  chunk     → structure-first, ~500 tokens, ~15% overlap (checks there is something to index)
  step 4  embed     → batched, with "Title › Section" header prepended
          + commit  → ONE transaction: replace chunks + set READY
        ↓
permanent failure → FAILED + human-readable reason
```

Embed and commit share one job step: vectors are too big to pass between steps, and the chunks table can't hold a chunk without its vector. The commit is still a single transaction.

### Extraction per type
| Type | Tool | Location kept |
|---|---|---|
| PDF | `unpdf` (from R2) | Page number |
| Website | Firecrawl | Heading path |
| Website, a learning path's official docs | Firecrawl: the page + up to 8 pages it links to in its own section, as one text (L-08) | Heading path (page title first) |
| YouTube | Supadata transcript API | Start timestamp |
| Text / markdown | none | Heading path / offset |

### Reliability mechanisms
1. **API never processes**: responds instantly, the job does the work
2. **Inngest steps**: each retried independently; finished steps not repeated
3. **Big data in DB, not between steps**: steps pass IDs only
4. **Atomic commit**: all or nothing, so half-indexed is impossible
5. **Idempotent**: re-running gives the same result
6. **Transient vs permanent errors**: retry with backoff (3×) vs fail fast with a reason
7. **Stuck-job sweeper**: scheduled job fails anything in `PROCESSING` too long, and sends the job event again for anything left in `PENDING` too long (an event that was never sent or never picked up)
8. **Dedupe**: normalized URL / file content hash per notebook
9. **Concurrency + throttle** per user and per external API
10. **Clean delete**: source row + chunks (same DB) + R2 file

**Scanned PDFs** (no text layer) → permanent failure; OCR out of scope.

**Chunking numbers (~500 tokens, ~15% overlap) are starting values, tuned by evals.**

---

## 7. Retrieval pipeline (advanced RAG)

```
1. Query understanding   one Luna call, structured output:
                         { needsRetrieval, standaloneQuery, subQueries[] }
2. Hybrid search         vector + keyword, in parallel, filtered by notebook
                         (and by source IDs for lesson-scoped chat)
3. Fusion                Reciprocal Rank Fusion → ~40 candidates
4. Rerank                rerank API → top ~6–8
5. Relevance gate        top score < threshold → "not in your sources"
6. Context building      dedupe, number [1] [2]…, token budget
7. Generation            grounded prompt, cites [n], streamed
8. Citation check        drop invalid [n]; valid ones link to page / timestamp / passage
```

| Technique | Problem it solves |
|---|---|
| Query rewrite | Follow-ups ("its disadvantages") are meaningless to search |
| Routing | "thanks!" shouldn't trigger a search |
| Sub-queries | "compare X and Y" as one search finds only one side |
| Hybrid search | Vectors miss exact terms; keywords miss meaning |
| RRF | Vector and keyword scores aren't comparable; ranks are |
| Rerank | Embeddings are rough; the right chunk is often top-40, not top-5 |
| Relevance gate | Search always returns *something*; enforces "never invent" in code |
| Citation check | LLMs sometimes cite sources that don't exist |

**Feature flags** switch rewrite / hybrid / rerank / sub-queries on and off, which is **required for eval ablations**.

**Eval-gated (only added if evals show a gain):** HyDE, LLM-written chunk context
**Deliberately skipped:** GraphRAG, agentic retrieval loops, web fallback in chat, fine-tuned embeddings

**Latency budget:** under ~3s to first token (understanding ~0.5–1s, embed ~0.2s, search ~0.1s, rerank ~0.3–0.5s, first token ~0.5s)

---

## 8. Learning path pipeline

**Background job: `generateLearningPath`** (progress shown in UI)

```
1. Clarify    (UI)   topic + level + goal; memory pre-fills level → user confirms;
                     scope check (one Luna call): too broad → 4–6 focus options
2. Gather     (job)  Tavily searches → Luna judges results → code picks
                     1 official source + up to ~5 popular ones (L-06)
3. Read       (job)  learning notebook created (draft); resources ingested
                     via processSource — scraped once, reused for mapping + lessons;
                     the official docs are read as a section: the page + up to 8
                     pages it links to (L-08)
4. Map        (job)  fan-out: concepts per resource (parallel) → merge duplicates
                     + the model's own concept list for the topic (L-09)
                     → consensus score (official source weighted highest,
                       the model's list one lighter vote, never a source);
                     each map marks its resource mapped (progress UI names them)
5. Order      (job)  prerequisite order → group into 3–10 modules, count set by
                     the topic's breadth; each module: title, summary, why it
                     matters, relative difficulty
6. Cut        (job)  code rules by level:
                       beginner     = high consensus
                       intermediate = high + medium
                       advanced     = job pauses (waitForEvent) → user picks branch → resume
                     everything else → "Skipped for now" with reason
7. Hook       (job)  what / why / example / 2-line origin
8. Ready      (UI)   user reviews, unchecks modules, starts
```

- **Map → cut details:** decision L-07 (consensus weights, cut thresholds, branches = sets of modules)
- **Module time** is computed in code after the cut: included concepts × minutes per concept for the level (`config/`), so it matches what is actually taught (L-11)
- **No official docs** (e.g. history topics) → most authoritative sources take that role
- **Partial failure OK**; fewer than 3 resources succeed → path fails with a reason
- **The LLM does language tasks; code makes the decisions** → consistent and explainable
- **Tavily finds, Firecrawl reads**: each behind a provider interface, each a fallback for the other

---

## 9. Lesson pipeline

**Streamed live, not a background job** (the user is waiting). Curio is the teacher: it studied the resources (full ingestion), so the learner doesn't have to (L-10).

```
open module → saved? show it
            → else (starts at once, no button):
              retrieval pipeline: one sub-query per concept of the module,
                this notebook's sources → fusion → rerank → relevance gate per concept
            → generate (teaching prompt):
                intro (why this module, link to the last one)
                per concept: intuition → precise idea [n] → worked example
                             (runnable code if technical) → misconception
                key takeaways
            → citation check → stream → save on completion
```

- **Grounding rule:** factual claims are cited `[n]`; examples, analogies and code are the teacher's own and must agree with the sources. The faithfulness eval judges the factual claims only
- **Concepts with nothing relevant** (gate fails for that concept, e.g. the model's own concepts or gap prerequisites) are taught briefly with no citations, under the note *"General knowledge, not in the resources"*
- Same citation check as chat; sources shown only as citations + a list built from the snapshots
- Level + learning style shape tone and depth
- Regenerate creates a new version
- Mark done → progress saved + topic memory updated
- Model: Luna at higher reasoning effort; upgraded to Sol only if evals show lessons are weak

### Tutor (per module)
The lesson's chat ("ask about this"): a normal conversation with `lesson_id` set, so it reuses the chat pipeline, summary and memory extraction.

- **Searches** only the sources cited by that lesson version (as before)
- **Knows:** the lesson text, the module (title, summary, why), the path's other modules (summary, done or not)
- **Stays on topic:** questions outside the module and the path get a one-line redirect to the lesson or the right module; instructions in sources or messages to leave the role are ignored
- Gate fails but the lesson covers it → answers from the lesson, no new citations; otherwise "not in your sources"
- **Suggests "mark done"** when the learner seems ready: the server strips the model's trailing marker and sends an `action` stream event; the UI shows a button and the learner clicks (the model never writes progress or memories)

---

## 10. Memory

### Long-term (custom, Postgres)
**Each memory:** `scope` (global / topic) · `topic` · `kind` (level / style / goal / understood / fact) · `content` · `origin`

**Written by:**
- **Direct events (no LLM):** level confirmed → `level`; lesson marked done → `understood` concepts
- **Chat extraction job:** Luna extracts **learner facts only** (never source content); same scope + topic + kind → **update, not duplicate**

**Used by:**
- Global memories always included (few, short)
- Topic memories fetched by SQL filter for the notebook's topic
- Related topics found via embedding similarity on topic names (for level pre-fill)
- **Level is per topic; for a new topic Curio always asks, and only pre-fills + confirms for same/related topics**
- **Memory shapes tone and depth only; citations come only from sources**

**User control:** memory page (view / edit / delete) + a notice when a new memory is saved

### Conversation (short-term)
- Rolling summary per conversation + marker of covered messages
- Summary updated by a background job when unsummarized messages pass a threshold
- Chat context = **summary + last ~10 messages**

---

## 11. Background jobs (Inngest)

| Job | Trigger | Purpose |
|---|---|---|
| `processSource` | `source/created`, `source/reprocess` | Ingestion pipeline |
| `sweepStuckSources` | Schedule (cron, every 5 min) | Fail sources stuck in `PROCESSING`; re-send sources stuck in `PENDING` |
| `cleanupNotebookFiles` | `notebook/deleted` | Delete a deleted notebook's files from R2 |
| `generateLearningPath` | `path/requested` | Learning path pipeline (with pause for advanced) |
| `summarizeConversation` | `conversation/summarize` | Rolling summary |
| `extractMemories` | `memory/extract` | Learner facts from chat |

The Inngest endpoint is **signed**, so only Inngest can trigger jobs.

---

## 12. Observability

- **Langfuse:** one trace per chat/lesson request, one span per pipeline step (inputs, outputs, chunk IDs + scores, tokens, cost, latency)
- Background jobs traced too; Inngest dashboard for runs and retries
- **👍 / 👎 feedback** attached to the trace as a score
- **`pino` structured logs** with a request ID
- **Privacy:** chunk text truncated in traces; no full source content logged

---

## 13. Evals

- **Golden dataset:** ~5–8 documents (all source types), ~40–60 questions with expected answer + location, ~10 unanswerable
- LLM drafts questions → **owner reviews and fixes them**
- **Retrieval metrics:** hit rate@k, MRR
- **Answer metrics (LLM judge = Luna, decision O-04):** faithfulness, correctness, citation accuracy, refusal accuracy
- **Learning path metrics:** coverage of official docs' core sections, consistency across runs
- **Runner:** TypeScript (`pnpm eval`); results saved as JSON in `evals/results/`
- **Ablation:** vector only → + rewrite → + hybrid → + rerank → + sub-queries
- **When:** at milestones and before any RAG config change; not on every commit
- **Offline only**, never deployed. Production quality is watched via traces + feedback.

---

## 14. Security, limits, errors

### Security
- Clerk token verified on every request; `userId` scoping on every query; 404 for others' resources
- Zod validation on every input (shared schemas)
- **PDFs upload browser → R2 via short-lived signed URL** (avoids Vercel body size limits); file type checked by content
- **Prompt injection:** source content delimited and marked as data; chat has no tools, so the worst case is a bad answer
- CORS: frontend origin only · secrets in env · `helmet` headers · signed Inngest endpoint

### Quotas
| Limit | Value |
|---|---|
| PDF size | 25 MB |
| YouTube length | 3 hours |
| Pasted text | 100k characters |
| Sources per notebook | 50 |
| Notebooks per user | 30 |

### Rate limits (per user, Upstash Redis)
| Action | Limit |
|---|---|
| Chat messages | 20 / min, 200 / day |
| Lesson generations | 50 / day |
| Learning paths | 5 / day |
| Path scope checks | 30 / day |
| Source adds | 50 / day |

Over limit → `429` with retry time. All values in one config file.

### Errors
- Error classes + global handler → one format: `{ "error": { "code", "message" } }`
- **Graceful degradation:** rerank down → skip it; query understanding fails → raw query; generation fails → error event in stream
- Every external call has a **timeout**

---

## 15. Scaling story

**Done now:** stateless API · Neon pooler · HNSW + notebook filter · provider interfaces · per-task model config · static prompt prefix first (OpenAI caches it, 90% cheaper input) · limits in config

**Later, when triggered:**

| Bottleneck | Trigger | Change |
|---|---|---|
| LLM + rerank cost | Bill over budget | Global learning-path cache, self-hosted reranker, Batch API for non-urgent jobs |
| Repeated paths | Same topic + level often | Cache concept maps per topic + level across users |
| DB load | CPU > 70% | Read replicas for search |
| Vector search | Latency rises, tens of millions of chunks | Partition by notebook → dedicated vector DB |
| Provider limits | Frequent 429s | Multi-provider fallback |
| Scraping | Quota hit | Paid tier or self-hosted scraper |
| Hosting cost | Long streams expensive | Backend to containers |
| Tracing volume | Cost grows | Sample ~10% + all errors |

**Key insight:** every search is scoped to one notebook, so the index naturally partitions. The real limit at scale is **API cost, not code**.

---

## 16. Post-launch ideas

- "Continue learning" section
- "Curio Wrapped" (learning recap)
- Mem0 for free-form memory
- Online faithfulness scoring on a sample of real answers
- Everything in the PRD's "Future ideas"
