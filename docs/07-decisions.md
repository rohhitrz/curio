# Curio — Decision Log (v1)

> **Status:** Approved
> **Purpose:** every major decision, with **what we chose, the alternatives, why, and the trade-off**. This is the owner's interview-prep doc.
> **Rule:** new decisions made during the build are added here (e.g. reranker choice, HyDE result).

---

## The 30-second architecture pitch

> *"Curio is a NotebookLM-style learning app. Users bring PDFs, videos, and websites, or just a topic, and get grounded, cited answers and lessons. It's a TypeScript monorepo: a Next.js frontend and an Express backend on Vercel, with Postgres and pgvector on Neon. Ingestion runs as step-based Inngest jobs with an atomic commit, so a source can never be half-indexed. Retrieval is a hybrid pipeline: query rewriting, vector plus keyword search fused with RRF, reranking, and a relevance gate that refuses instead of hallucinating. Every technique was kept only if it improved an eval metric, and I have the ablation table to prove it."*

---

## 1. Product decisions

**P-01 · Primary user: the self-directed learner**
- **Alternatives:** "anyone"; students only
- **Why:** "anyone" can't guide design decisions; learners need accurate, cited answers, which justifies advanced RAG
- **Trade-off:** casual users are served but not designed for

**P-02 · Two entry points: "I have material" + "I have a topic"**
- **Why:** covers both learner situations; both run on the same RAG core
- **Trade-off:** more scope than a pure NotebookLM clone

**P-03 · Curio generates lessons (not just curates resources)**
- **Alternatives:** curate a path + resources only
- **Why:** stronger product; exercises the RAG pipeline further
- **Trade-off:** more scope and LLM cost

**P-04 · Long-term memory in v1**
- **Alternatives:** defer to v2
- **Why:** the learn-a-topic feature needs the learner's level and style
- **Trade-off:** more scope; privacy responsibility (view/edit/delete required)

**P-05 · Level is per topic, never global**
- **Why:** skill doesn't transfer across topics; learning style does
- **Implementation:** always ask for a new topic; pre-fill + confirm only for same/related topics

**P-06 · Podcast, PPT, quizzes, flashcards out of v1**
- **Why:** impressive demos that don't showcase RAG; the old Curio had many features and a weak core

---

## 2. Architecture decisions

**A-01 · Separate Express backend in a monorepo**
- **Alternatives:** Next.js API routes
- **Why:** clean frontend/backend separation; **portable off Vercel with zero code changes**; matches backend background and the layered pattern
- **Trade-off:** two deployments, CORS, auth token crossing the boundary

**A-02 · Neon Postgres**
- **Alternatives:** Supabase
- **Why:** serverless, free tier, branches for dev/test/prod; **Supabase pauses inactive free projects** (a real risk for a portfolio demo)
- **Trade-off:** no bundled extras (not needed: auth is Clerk, backend is ours)

**A-03 · pgvector, not Pinecone**
- **Alternatives:** Pinecone
- **Why:** chunks + embeddings + status change in **one transaction** → half-indexed sources become impossible; hybrid search in one DB; notebook isolation is a `WHERE`
- **Trade-off:** at tens of millions of vectors, a dedicated vector DB would scale better (documented in the scaling story)

**A-04 · Drizzle, not Prisma**
- **Alternatives:** Prisma (used in the cohort)
- **Why:** SQL-heavy queries; native pgvector support; Prisma would need raw SQL for every vector query
- **Trade-off:** differs from the cohort material

**A-05 · Cloudflare R2 for PDFs**
- **Alternatives:** Cloudinary
- **Why:** S3-standard and portable; free egress; Cloudinary is built for image/media transformation
- **Trade-off:** none significant

**A-06 · Inngest with step-based jobs**
- **Why:** each step retried independently and not repeated; fits Vercel time limits; supports pause/resume (`waitForEvent`)
- **Trade-off:** another external service

**A-07 · Upstash Redis for rate limits and locks**
- **Alternatives:** in-memory counters
- **Why:** serverless instances don't share memory, so in-memory limits don't work
- **Trade-off:** another service (free tier)

**A-08 · GPT-6 Luna by default, model configurable per task**
- **Why:** very cheap; heavier tasks (paths, lessons) can be upgraded to Sol **only if evals show the need**
- **Trade-off:** Luna may be weaker at deep reasoning; mitigated by per-task config

**A-09 · Provider interfaces for every external service**
- **Why:** swapping a vendor = one file; enables fake providers so **tests never call paid APIs**

---

## 3. Ingestion decisions

**I-01 · The API never processes; it saves `PENDING` and responds instantly**
- **Why:** long work would time out on Vercel and block the UI

**I-02 · Atomic commit: replace chunks + set `READY` in one transaction**
- **Why:** the core fix for the old Curio's indexing bugs; all or nothing

**I-03 · Big data in the DB, IDs between job steps**
- **Why:** job systems limit step payload size; passing a book between steps fails silently

**I-04 · Transient vs permanent errors**
- **Why:** retry network blips; fail corrupt PDFs immediately with a human message

**I-05 · Stuck-job sweeper**
- **Why:** guarantees nothing stays in `PROCESSING` forever, even after a crash

**I-06 · Dedupe enforced by a DB constraint**
- **Why:** only the database stops a double-click race; code checks can both pass

**I-07 · Transcript API for YouTube, not a free library**
- **Why:** free transcript libraries are often blocked from cloud servers (works locally, fails in production)

**I-08 · Tavily finds, Firecrawl reads**
- **Why:** each is best at one job; both behind interfaces, each a fallback for the other

**I-09 · Structure-first chunking (~500 tokens, ~15% overlap)**
- **Why:** chunks that cross sections lose meaning; chunks that cross pages can't be cited to one page
- **Note:** numbers are starting values, tuned by evals

**I-10 · Context headers ("Title › Section") before embedding**
- **Why:** gives ambiguous chunks context at zero cost; LLM-written context is eval-gated

**I-11 · `text-embedding-3-small`, model name stored per chunk**
- **Why:** cheap and strong; storing the model shows which sources need re-embedding after a switch

---

## 4. Retrieval decisions

**R-01 · One LLM call for rewrite + route + sub-queries**
- **Why:** three jobs in one fast structured call instead of three slow ones

**R-02 · Hybrid search (vector + keyword)**
- **Why:** vectors miss exact terms (codes, names); keywords miss meaning

**R-03 · Reciprocal Rank Fusion**
- **Why:** vector and keyword scores aren't comparable; ranks are; no tuning needed

**R-04 · Reranking the top ~40 → top ~6–8**
- **Why:** embeddings compare query and chunk separately; a reranker reads them together. Usually the biggest single quality gain.
- **Trade-off:** extra latency (~0.3–0.5s) and cost; the main cost driver at scale

**R-05 · Relevance gate**
- **Why:** search always returns *something*; enforces "never invent" in code, not just in a prompt

**R-06 · Deterministic citation check**
- **Why:** LLMs sometimes cite sources that don't exist

**R-07 · Every technique behind a feature flag, kept only if evals improve**
- **Why:** enables the ablation table; prevents over-engineering

**R-08 · Deliberately skipped: GraphRAG, agentic loops, web fallback in chat, fine-tuned embeddings**
- **Why:** heavy, slow, out of scope, or needs data we don't have. HyDE is eval-gated.

---

## 5. Learning decisions

**L-01 · Consensus framework: importance = how many trusted resources cover a concept**
- **Why:** turns "what should we teach?" into something structured, explainable, and testable

**L-02 · LLM does language tasks; code rules make the decisions**
- **Why:** same inputs → same path; every include/skip is explainable with evidence

**L-03 · Learning resources go through the normal ingestion pipeline**
- **Why:** scraped once, reused for mapping, lessons, and chat; no second system

**L-04 · Advanced path pauses mid-job for the branch choice (`waitForEvent`)**
- **Why:** the user's choice happens inside one job, no workarounds

**L-05 · Lessons generated on demand, saved as versions**
- **Why:** unopened modules cost nothing; regenerate never loses the old lesson

---

## 6. Memory decisions

**M-01 · Custom memory on Postgres, not Mem0**
- **Alternatives:** Mem0; hybrid (structured + Mem0), considered and rejected
- **Why:** our memory is mostly **structured and event-driven** (level confirmed, lesson done); Mem0 is built for free-form memory; custom is small and fully explainable
- **Trade-off:** we build extraction + dedupe ourselves. Mem0 is on the post-launch list.

**M-02 · Typed memories: scope (global/topic) + kind**
- **Why:** enforces "level is per topic" with DB constraints, not just code

**M-03 · Memory personalizes; sources ground**
- **Why:** memory changes tone and depth only; citations come only from sources

**M-04 · User edits always win**
- **Why:** if the AI undoes a user's correction, trust in the feature is gone

**M-05 · Rolling conversation summary + last ~10 messages**
- **Why:** long chats stay coherent while cost and latency stay flat

---

## 7. Data decisions

**DB-01 · UUIDs, not sequential IDs**
- **Why:** sequential IDs in URLs are guessable and reveal record counts

**DB-02 · Denormalized `user_id` / `notebook_id`**
- **Why:** one-`WHERE` ownership checks; searches never need a join
- **Trade-off:** duplicated columns to keep consistent (set once at creation, never changed)

**DB-03 · Citations stored as snapshots, not chunk links**
- **Why:** reprocessing creates new chunk IDs and deletes remove chunks; snapshots keep old answers intact

**DB-04 · `seq` for message order, not timestamps**
- **Why:** timestamps can collide; `seq` gives exact order and simple "through_seq" markers

**DB-05 · Optimistic concurrency for summaries**
- **Why:** two jobs at once → only one applies, with no locks needed

**DB-06 · Shared `topics` table with name embeddings**
- **Why:** each topic embedded once; related topics found by similarity, never wrongly merged

**DB-07 · Progress on `modules`, not a separate table**
- **Why:** a path has one owner; a progress table is a future migration for shared/cached paths

---

## 8. API decisions

**API-01 · Shallow nesting**
- **Why:** shorter URLs; avoids the Express `mergeParams` bug from the cohort roadmap

**API-02 · One "add source" endpoint with a typed body**
- **Why:** all types enter the same pipeline; one schema, one place for quotas and dedupe

**API-03 · Cursor pagination**
- **Why:** page numbers shift as new items arrive (duplicates or gaps); cursors don't

**API-04 · 202 + polling, not WebSockets**
- **Why:** simple, serverless-friendly; a 2-second delay doesn't matter for 10–60s jobs

**API-05 · Frontend sends only the new chat message**
- **Why:** the server owns history, so it can't be faked; smaller requests; summary logic in one place

**API-06 · Redis lock per conversation/module with auto-expiry**
- **Why:** prevents interleaved answers; expiry means a crash never leaves a chat stuck

**API-07 · 404, never 403, for other users' resources**
- **Why:** 403 confirms the resource exists

**API-08 · PDFs upload directly from browser to R2**
- **Why:** avoids Vercel's request size limit; storage keys prefixed by user ID so no one can register another user's file

**API-09 · `PUT` for "set a value" actions (feedback, completion)**
- **Why:** idempotent: clicking twice gives the same result

---

## 9. Observability & eval decisions

**O-01 · Langfuse, one span per pipeline step**
- **Why:** a bad answer can be traced to the exact failing step

**O-02 · Evals in TypeScript, not Python + Ragas**
- **Alternatives:** Python eval harness with Ragas
- **Why:** one language and toolchain; the metrics (faithfulness, context recall…) matter, not the library
- **Trade-off:** can't claim "used Ragas"; can claim the same metrics

**O-03 · Relevance judged by location, not chunk ID**
- **Why:** chunk IDs change with chunking; location matching makes chunk-size experiments comparable

**O-04 · Sol judges Luna's answers**
- **Why:** a model grading its own tier of work is less reliable

**O-05 · False refusal rate tracked alongside refusal accuracy**
- **Why:** a gate that refuses everything would score perfectly on refusal accuracy alone

---

## 10. Process decisions

**PR-01 · Docs before code; doc updated first if the design changes**
- **Why:** the owner understands and controls every decision; the agent never builds on stale plans

**PR-02 · Vertical slices (backend + frontend per phase)**
- **Why:** something working and visible after every phase

**PR-03 · Deploy in phase 1**
- **Why:** deployment surprises are cheap to fix in a tiny app

**PR-04 · Evals before chat**
- **Why:** you can't prove an improvement without a baseline measured first

**PR-05 · Commit + push after every step, no Claude attribution**
- **Why:** clean history; every eval result tied to a commit

---

## 11. Post-launch ideas

- "Continue learning" section
- "Curio Wrapped" (learning recap)
- Mem0 for free-form memory
- Manual memory add (`POST /memories`)
- Online faithfulness scoring on a sample of real answers
- Orphaned-upload cleanup job
- Global learning-path cache across users
- Everything in the PRD's "Future ideas"

---

## 12. Decisions to be made during the build

| Phase | Decision | Recorded as |
|---|---|---|
| 3 | Transcript API vendor (e.g. Supadata) | I-12 |
| 6 | Reranker: Cohere vs Jina | R-09 |
| 6 | HyDE: kept or dropped (with numbers) | R-10 |
| 6 | Chunk size after tuning | I-13 |
| 6 | Relevance gate threshold | R-11 |
| 9 | Lessons: Luna enough, or upgrade to Sol? | A-10 |
