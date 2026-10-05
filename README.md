# Curio

An AI learning workspace in the spirit of NotebookLM. Two ways in:

1. **"I have material"**: add PDFs, websites, YouTube videos or notes to a notebook and chat with
   them. Every answer is grounded in your sources and cited down to the page, timestamp or
   section, or it says the answer is not in your sources.
2. **"I have a topic"**: say what you want to learn and at what level. Curio finds trusted
   resources, reads them in full, builds a learning path from what they agree on, and teaches each
   module as a streamed, cited lesson with a tutor beside it.

What it is built to show: **ingestion that never leaves a source half-done, and retrieval whose
quality is measured by evals rather than assumed.** Every retrieval technique sits behind a
feature flag and was kept only after the eval showed a gain.

**Live:** [curio-web-theta.vercel.app](https://curio-web-theta.vercel.app) (Clerk is still on its
development instance).

## Architecture

```mermaid
flowchart TD
  B[Browser] -->|Clerk session token| W["apps/web<br/>Next.js UI"]
  B -->|PDF upload, signed URL| R2[(Cloudflare R2<br/>PDFs only)]
  W -->|REST + SSE streaming| S["apps/server · Express<br/>Route → Controller → Service → Repository"]
  S --> PG[("Neon Postgres + pgvector<br/>everything but files")]
  S --> I["Inngest<br/>step-based jobs"]
  S --> U[("Upstash Redis<br/>rate limits, locks")]
  S --> X["Providers in src/lib/<br/>OpenAI · Cohere rerank · Tavily<br/>Firecrawl · Supadata transcripts"]
  I -->|processSource, generateLearningPath,<br/>memory, sweeper| S
  S -.->|one span per pipeline step| L[Langfuse]
```

**Ingestion** (`apps/server/src/pipelines/ingestion/`): the API validates, dedupes, saves the
source as `PENDING` and answers at once. An Inngest job then extracts (unpdf, Firecrawl,
Supadata), chunks by structure (~500 tokens, 15% overlap), embeds with a "Title › Section" header,
and replaces the chunks and sets `READY` in **one transaction**. Every source ends `READY` or
`FAILED` with a human-readable reason; a sweeper catches anything stuck.

**Retrieval** (`apps/server/src/pipelines/retrieval/`), each step behind a flag in
`apps/server/src/config/flags.ts`:

```
question → understand (one Luna call: route + standalone rewrite)
         → vector + keyword search in parallel → RRF fusion (~40 candidates)
         → Cohere rerank → top 8 → relevance gate (top score < 0.70 → "not in your sources", no model call)
         → numbered context → streamed answer citing [n] → citation check drops any [n] the model never saw
```

**Learning paths** (`pipelines/learning/`): Tavily finds resources and the model judges them;
code picks one official source and up to five popular ones; each is ingested like any source;
the model maps concepts per resource and merges them; **code** scores consensus (official docs
weigh most), orders and cuts by level. The model does the language tasks, code makes the
decisions.

**Lessons and tutor** (`pipelines/lessons/`, `pipelines/tutor/`): one retrieval per concept of a
module, a teaching prompt (intuition → cited idea → worked example → common misconception), the
same citation check as chat. The tutor only searches the sources its lesson cited.

**Memory** (`pipelines/memory/`): typed long-term memories on Postgres, extracted after chats and
editable by the user. Memory personalizes; sources ground.

Full design: [`docs/02-system-design.md`](docs/02-system-design.md).

## Eval results

The golden dataset (`evals/dataset/`) is 7 documents on ML fundamentals covering every source
type (2 PDFs, 2 websites, 2 YouTube videos, 1 note; 238 chunks), with 60 answerable questions
across four categories and 10 unanswerable ones. Relevance is judged by **location** (page,
timestamp window, heading path), not chunk ID, so different chunkings compare fairly. Answers are
judged by GPT-6 Luna with fixed prompts (`evals/judges/`), averaged over 2 runs.

**Ablation** (each row adds one technique to the row above):

| Config                                 | Hit@5     | MRR       | Faithfulness | Correctness (1–5) | Citation acc. | Refusal acc. | False refusals |
| -------------------------------------- | --------- | --------- | ------------ | ----------------- | ------------- | ------------ | -------------- |
| Vector only                            | 0.933     | 0.796     | 0.976        | 4.50              | 0.832         | 0.90         | 0.008          |
| + query rewrite                        | 0.950     | 0.814     | 0.956        | 4.59              | 0.867         | 0.95         | 0              |
| + hybrid search (RRF)                  | 0.967     | 0.845     | 0.963        | 4.73              | 0.865         | 0.95         | 0              |
| + rerank (Cohere v4.0 fast)            | 1.000     | 0.983     | 0.968        | 4.78              | 0.847         | 0.95         | 0              |
| + relevance gate 0.70                  | 1.000     | 0.983     | 0.990        | 4.74              | 0.842         | 1.00         | 0              |
| **Final pipeline, re-run (`eb41c05`)** | **1.000** | **0.983** | **0.969**    | **4.72**          | **0.884**     | **1.00**     | **0**          |

Where each technique helped:

- **Query rewrite:** follow-up questions ("Is it deterministic?") went from correctness 3.50 to
  4.67, MRR 0.54 to 0.73.
- **Hybrid search:** multi-part questions went from MRR 0.55 to 0.81, and from 1 in 12 to 8 in 12
  answers scoring 4 or more. Keyword matches find the second half of "compare X and Y".
- **Rerank:** the right passage is in the top 5 for every answerable question (MRR 0.85 to 0.98).
  Its 0–1 scores are what make the gate possible.
- **Relevance gate:** all 10 unanswerable questions refused before the model runs, with no
  answerable question refused.
- **Not adopted:** HyDE and chunk-size tuning (retrieval was already at the dataset's ceiling,
  R-09); sub-queries (not measured, R-10). Both remain behind flags.

**Other evals:**

| Eval                                                                                    | Result                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Lesson faithfulness: supported factual claims ÷ factual claims, 6 lessons (Python, Git) | **0.936** (171 claims)                                 |
| Prompt injection: 5 surfaces × 3 attacks × 3 runs, scored in code by a canary string    | **0 / 45 hijacked**, 45 / 45 stayed on task            |
| Learning-path coverage: Python beginner path vs the official tutorial's core sections   | 0.82 (single run; the full 3-topic run is still to do) |

Every result file is in `evals/results/` with its git commit, config, models, cost and every
question's retrieved chunks. A full answer eval costs about $0.21.

## Key decisions

All 84 decisions, with alternatives and trade-offs, are in
[`docs/07-decisions.md`](docs/07-decisions.md). The ones that shape the system most:

| Decision                                                             | Why                                                                                                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **pgvector in Postgres**, not a separate vector DB (A-03)            | Chunks live next to their source, so indexing and deleting are single transactions: a half-indexed source is impossible |
| **The API never processes** (I-01); Inngest step jobs (A-06)         | Requests return instantly; each step retries alone and finished steps aren't repeated, within Vercel's time limits      |
| **Atomic commit** of chunks + `READY` (I-02)                         | All or nothing; re-running a source gives the same result                                                               |
| **Every technique behind a flag, kept only if evals improve** (R-07) | Produces the ablation table and keeps out complexity that doesn't pay                                                   |
| **Relevance gate in code** (R-05)                                    | Search always returns _something_; "never invent" is enforced before the model sees weak matches                        |
| **Deterministic citation check** (R-06)                              | Models sometimes cite sources that don't exist; the saved answer only has markers that point at a real passage          |
| **Citations stored as snapshots** (DB-03)                            | Re-indexing a source never breaks an old answer's citations                                                             |
| **LLM for language, code for decisions** in learning paths (L-02)    | Consistent, explainable paths: consensus scores and cut rules are plain code                                            |
| **Untrusted text is fenced** in every prompt (10.4)                  | Sources and web pages are data; an instruction inside one can't change behaviour                                        |
| **Provider interfaces** for every external service (A-09)            | Swapping a vendor is one file, and tests run on fakes with no external calls                                            |
| **404, never 403**, for other users' resources (API-07)              | Existence of someone else's notebook is never leaked; a test calls every ID route as another user                       |
| **Luna everywhere, Sol only if evals demand it** (A-08, L-12)        | Luna met every quality bar at a fraction of the cost, including as the judge (O-04)                                     |

## Repository

```
apps/web          Next.js UI (Tailwind, shadcn/ui, TanStack Query, AI SDK streaming)
apps/server       Express API: routes → controllers → services → repositories; lib/ providers;
                  pipelines/ (ingestion, retrieval, learning, lessons, tutor, memory); inngest/ jobs
packages/shared   Zod schemas and types shared by both apps
evals             Golden dataset, eval runners, judge prompts, results
docs              PRD, system / database / API design, build plan, test plan, decisions, progress
```

Limits, model per task, thresholds and flags all live in `apps/server/src/config/`.

## Running it locally

**Needs:** Node 22+, pnpm 11, Docker (for tests only), and accounts for Neon, Clerk, Cloudflare R2,
Inngest (none needed locally), OpenAI, Firecrawl, Supadata, Tavily, Langfuse, Upstash and Cohere.

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`; each key has a comment saying where to get it. For local work use a Neon `dev`
branch for `DATABASE_URL`, set `INNGEST_DEV=1`, `PORT=4000`,
`NEXT_PUBLIC_API_URL=http://localhost:4000` and `CORS_ORIGINS=http://localhost:3000`.

Run the migrations on your dev database:

```bash
pnpm --filter @curio/server db:migrate
```

Start the API (port 4000) and the web app (port 3000):

```bash
pnpm dev
```

In a second terminal, start the Inngest dev server so sources get processed:

```bash
pnpm dev:inngest
```

### Tests

Tests never call an external API: every provider has a fake, and integration tests run on a
local Postgres + pgvector in Docker, reached through Neon's `wsproxy` so they use the production
driver. Set `TEST_DATABASE_URL=postgres://curio:curio@localhost:5434/curio_test`, then:

```bash
pnpm db:test:up
```

```bash
pnpm test
```

The full suite (server, web, evals) runs in under a minute. Only one run at a time: runs share the
test database. `pnpm lint` and `pnpm typecheck` cover the whole repo.

### Evals

Evals call real APIs and run against your Neon `dev` branch, never production or the test
database. On a new machine, fetch the dataset's documents first (third-party content is never
committed):

```bash
pnpm --filter @curio/evals fetch-docs
```

```bash
pnpm eval
```

`pnpm eval -- --retrieval-only` gives retrieval metrics only for under a cent, and
`--flags=queryRewrite,hybridSearch` runs an ablation config. See [`evals/README.md`](evals/README.md)
for every option and `pnpm eval:lessons`, `pnpm eval:paths`, `pnpm eval:injection`.

## Deployment

Two Vercel projects (`curio-web`, `curio-server`) deploy on every push to `main`; the database is
the Neon `main` branch, migrated with `pnpm --filter @curio/server db:migrate:prod`. After
deploying new Inngest functions, resync the app in the Inngest dashboard.
