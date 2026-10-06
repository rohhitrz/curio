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

**A-10 · AWS SDK v3 for R2, with flexible checksums off**
- **Alternatives:** a hand-rolled SigV4 signer; R2's Workers bindings (not usable from Vercel)
- **Why:** R2 is S3-compatible; the official SDK signs PUT/GET URLs and handles head/delete. It lives only behind the storage provider in `lib/`
- **Config:** `requestChecksumCalculation` and `responseChecksumValidation` = `WHEN_REQUIRED`, because the SDK's default checksums add headers that break R2 presigned uploads from the browser
- **Trade-off:** a large dependency for four operations

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

**I-12 · Supadata as the transcript API, native captions only**
- **Alternatives:** other hosted transcript APIs; letting the vendor generate a transcript with AI when a video has no captions
- **Why:** one HTTP API gives timestamped caption segments plus the video's title and length, and works from cloud servers (I-07). `mode=native` keeps cost and latency predictable
- **Trade-off:** a video without captions fails with a clear reason instead of being transcribed

**I-13 · Embed and commit in one job step; locations kept in `sources.extracted_locations`**
- **Alternatives:** five separate steps with a staging table for embedded chunks; locations hidden inside `sources.metadata`
- **Why:** steps pass only IDs (I-03), but vectors are too big for step output and `source_chunks.embedding` is `NOT NULL`, so there is nowhere to keep them between an "embed" and a "commit" step. One step keeps the commit a single transaction (I-02). A dedicated column keeps page and timestamp boundaries out of `metadata`, which the API returns
- **Trade-off:** a failed commit re-runs the embedding call (a fraction of a cent)

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
- **Model (6.4, 2026-10-02): Cohere `rerank-v4.0-fast`.** Eval vs `rerank-v4.0-pro` on rewrite + hybrid: identical retrieval (hit@5 1.0, MRR 0.983, up from 0.845 without rerank), answers within noise (correctness 4.78 vs 4.83), latency p50 745 vs 1,112 ms (p95 1,224 vs 1,604), ~$2 vs ~$2.50 per 1,000 searches. Jina wasn't compared: no key, and the owner chose to skip it (2026-10-02). Latency is above the ~0.3–0.5s budget on a Trial key; chat's 3s rerank timeout falls back to the fused order

**R-05 · Relevance gate**
- **Why:** search always returns *something*; enforces "never invent" in code, not just in a prompt
- **How (6.5):** thresholds the **top rerank score** (0–1). Fused RRF scores and cosine similarity can't be thresholded (unanswerable questions reached cosine 0.68 while answerable ones sat at 0.24), so the gate is skipped when rerank didn't run
- **Threshold 0.70:** on the eval, unanswerable top scores reach 0.670 and answerable ones start at 0.725; 0.70 refuses all 10 unanswerable and none of the 60 answerable (0.65 misses one; 0.75 wrongly refuses two). Tuned on the same 10 questions it is scored on, with a narrow gap, so watch gated traces in Langfuse for false refusals
- **Per part (R-11, 2026-10-05):** with sub-queries, the gate takes the best top score across the whole question and its parts

**R-06 · Deterministic citation check**
- **Why:** LLMs sometimes cite sources that don't exist

**R-07 · Every technique behind a feature flag, kept only if evals improve**
- **Why:** enables the ablation table; prevents over-engineering

**R-08 · Deliberately skipped: GraphRAG, agentic loops, web fallback in chat, fine-tuned embeddings**
- **Why:** heavy, slow, out of scope, or needs data we don't have. HyDE is eval-gated.

**R-09 · 6.7 trials: HyDE off, chunk size stays 500 tokens** (2026-10-02)
- **Why:** with rewrite + hybrid + rerank + gate, retrieval is at the ceiling of the golden dataset (hit@5 1.0, MRR 0.983), so neither trial has room to show a gain, and HyDE costs one more LLM call (~0.5–1s) on the path to the first token. The owner stopped the trial runs before they finished; no result was recorded, so nothing was adopted (R-07: kept only if evals improve)
- **Left in place:** HyDE (`pipelines/retrieval/hyde.ts`, `hyde` flag off) and `pnpm eval -- --chunk-tokens=N`, to re-run if a harder dataset (e.g. paraphrased questions) brings retrieval below the ceiling

**R-10 · Sub-queries stay off; their ablation row was not run** (2026-10-05, owner, 11.1)
- **Why:** the final pipeline is at the dataset's retrieval ceiling (hit@5 1.0, MRR 0.983), so sub-queries could only show a gain on multi-part answers (correctness 4.42, citation accuracy 0.65), and a full run took ~1 hour that day. The owner moved on to the README; with no result, nothing is adopted (R-07). The lesson eval was not re-run after 10.4's prompt fencing either
- **Left in place:** the `subQueries` flag (off) and `pnpm eval -- --flags=queryRewrite,hybridSearch,rerank,relevanceGate,subQueries` to run the row later
- **Superseded by R-11** the same day: a live false refusal made the owner choose to build and measure it after all

**R-11 · Multi-part questions: rerank and gate per part** (2026-10-05, owner chose this over documenting the limitation, 11.3)
- **Problem:** on the live demo, "Compare ridge regression and lasso: how do their penalties differ, and when would you pick each?" was refused although the scikit-learn page covers both. Reranked as one query, a two-part question matches each chunk only half-way: in the 11.1 eval the multi-part questions had the lowest top scores of all (0.758, 0.769, 0.774 against the 0.70 gate), and the live wording fell below it
- **How:** behind the `subQueries` flag. Each sub-query gets its own vector + keyword search (as built in 6.2); then the fused candidates are reranked against the whole question and against each part in parallel; the lists are merged in turns (whole #1, part 1 #1, part 2 #1, whole #2, …, duplicates once with their best score) and cut to `rerankTopK`, so every part reaches the answer. The gate takes the best score of the merged chunks, so it refuses only when no part is relevant. Any rerank call failing → fused order, gate skipped (as before)
- **Cost:** one rerank call per part (≤ `maxSubQueries` 3 more) on multi-part messages only, in parallel; a Trial key's 10 calls/min fills faster
- **Kept only if the eval shows it** (R-07): multi-part gains, no regression elsewhere, no false refusals
- **Result: adopted, `subQueries` on** (`evals/results/2026-10-05-vector+queryRewrite+hybridSearch+rerank-v4.0-fast+subQueries+relevanceGate.json`, against the 11.1 final run): multi-part correctness 4.42 → 4.67, ≥ 4 0.83 → 0.92, citation accuracy 0.65 → 0.75; overall correctness 4.72 → 4.76, faithfulness 0.969 → 0.977, citation accuracy flat (0.884 / 0.881); refusals 1.0, false refusals 0, threshold 0.70 still the only clean one. Where parts were found, the gate score rose 0.758 → 0.891, 0.774 → 0.885, 0.829 → 0.888. Multi-part MRR 0.917 → 0.889: turns can put another part's passage first. 81 rerank calls instead of 70
- **Limit:** the parts come from the understanding call; past its 3s deadline (5 of 70 questions in this run, 3 of them multi-part) the question is searched and gated as one, as before. A longer deadline would help these and costs time to the first token only when OpenAI is slow
- **Parts name one thing each** (2026-10-06): even with the 5s deadline the live compare question was refused: its parts were "How do the penalties in ridge regression and lasso differ?" and "When should ridge regression be chosen, and when should lasso be chosen?", still comparisons, so every passage (scikit-learn's own Lasso section included) scored 0.52–0.62. The understanding prompt now asks for one sub-query per thing, naming only that thing ("ridge regression penalty", "lasso penalty"). Eval (`2026-10-06-…+subQueries+relevanceGate.json`, 3 understanding timeouts; a first run that day was discarded: OpenAI was slow and 29 of 70 understanding calls timed out): every multi-part question's parts name one thing, gate scores 0.855–0.928 (as one query 0.758–0.844), retrieval back at the ceiling (multi-part MRR 0.917), overall correctness 4.72, faithfulness 0.980, citation accuracy 0.893 (best yet), follow-up correctness 4.83, refusals 1.0, false refusals 0. Multi-part correctness 4.17 (runs so far: 4.42 without parts, 4.67 and 4.17 with): one question timed out and lost its parts; q-052 lost a second Dropout-paper passage because merging in turns gave the other part's list two weak "External links" chunks. Six questions make this category noisy; a merge that keeps each list's top 2 and fills by score is in todo-v2
- **Deadline 3s → 5s** (2026-10-06): after the deploy, the live compare question was refused again: its understanding call hit 3.00s, so no parts. Live understanding calls in Langfuse took 1.1–2.5s (median ~1.5s); 2 of 13 timed out, both the first chat after hours idle. 5s catches that tail and costs time only when the call is slow

**R-12 · Chat first token ~3–6s, not < ~3s** (2026-10-06, owner, 11.4)
- **Problem:** the PRD's "first token < ~3s" was not met: on the 7 live chats since rerank, the answer call started 2.6–5.5s after the request (median 4.3s), before the model's own first token. Understanding (median 2.3s) is the largest step; R-11's 5s deadline and per-part rerank added time for better multi-part answers
- **Decision:** accept ~3–6s and change the PRD target; measure it on every chat trace (`firstTokenMs`) instead of inferring it
- **Not done:** searching the raw question while understanding runs (~1s saved on most first messages): wasted searches on every rewritten question, and the owner wants no added retrieval cost · answering with `reasoningEffort: 'none'` (answer first token p50 1.1s in an invalid run): needs a paid eval to prove quality holds; the owner chose no more eval spend. Both stay in todo-v2
- **Trade-off:** slower first token, in exchange for multi-part questions that are answered instead of refused, and the gate's "not in your sources" refusals

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

**L-06 · Resource selection: the model judges each search result, code picks (8.3)**
- **How:** 3 searches (official docs · popular guides at the level and goal · videos) → one Luna call judges every result (relevant, official, authority 1–5, docs/article) → a pure function picks 1 `OFFICIAL` + up to 5 `POPULAR` (most authoritative first, one per site, at most 1 video; ties by search score, then order). Model down on the last attempt → search order decides.
- **Why:** "is this the official docs / a trustworthy page?" is a language judgement; the choice itself stays in code, so it is explainable and the same judgements give the same path (L-02)

**L-07 · Outline: model maps, merges and orders; code scores and cuts (8.4)**
- **How:** map (one Luna call per read resource, ≤ 20 concepts) → merge (one call groups what would be taught as one concept: same idea under other names, or a concept with its kinds and forms, e.g. "Loops" with "For loops"; a different idea it is built from stays apart; code checks the IDs) → **consensus** = weight of covering voters ÷ weight of all voters: the mapped resources and the model's own list (official 2, popular 1, model 1; L-09) → order (one call: prerequisite order, 3–10 modules, ≤ 3 gap prerequisites, 2–4 branches for advanced, each a set of modules; code repairs the output) → **cut** (pure): beginner ≥ 0.5, intermediate ≥ 0.25, at least 20 (beginner) / 16 (intermediate) concepts kept, best-covered added back, ties going to the earliest in the path (was 5 for both; the 8.7 eval kept 5–7 concepts from noisy resources, and 11–14 for beginner once the model voted), advanced = only the chosen branch's modules; gap concepts follow their module; every skip gets a reason → hook (one call, from the official resource's opening; failure → no hook)
- **Why:** consensus and cut are numbers and rules, so a path is explainable ("covered by 1 of 6 resources") and testable; branches as module sets keep the advanced path made of the same modules as the others

**L-08 · A path's official docs are read as a section, not a page (8.7)**
- **How:** the `OFFICIAL` resource (not a video) is saved with `metadata.sectionPages` = 8. Extraction scrapes it, takes the links in its main content that stay on the same host under the page's folder (in page order = table-of-contents order; no anchors, files or duplicates), scrapes up to 8 of them (4 at a time) and joins everything into one markdown text, each page under its title. Linked pages that fail for now (e.g. Firecrawl 429: the plan allows ~10 scrapes a minute) are tried once more after 30s; one that still fails, or fails for good, is left out; the first page failing fails the source as before. Still one source and one resource: consensus counts the official docs once. Its map gets a bigger budget (`officialMapMaxChars` 120k, ≤ 40 concepts), shared fairly: every top-level heading part (page) gets an equal share and short ones leave theirs to the long ones (`fairShare`, all resources), so the last pages aren't cut off. Firecrawl `scrape` only (no crawl API). User-added websites are unchanged
- **Why:** the 8.7 eval: the official tutorial's start page is a table of contents (6 concepts); the content is on the pages it links to, so no cut could reach the core sections. One source keeps L-03 (read once, reused by lessons and chat)

**L-09 · The model's own knowledge is one more vote in the consensus (8.7)**
- **How:** a `recall` step (one Luna call, alongside the maps) lists the topic's core concepts for the learner's level from the model's own knowledge (≤ 25). Merge groups them with the resources' concepts as one more voter, weight 1 (official 2, popular 1). It only adds to scores: it is not a resource, gets no coverage rows and is not counted in "covered by N of M resources". A concept only the model lists scores low (0.2 with 2 popular + official) and is kept only when the floor tops a path up ("Not in the resources (general knowledge only)" when skipped). Recall failing on the last attempt → the path is built from the resources alone
- **Why:** owner (2026-10-04): the model has seen far more material on a topic than the 3–6 resources a path reads. Its vote fills sections the resources miss and stops the official docs alone from passing every threshold (with 3 resources, official-only concepts scored 0.5, so beginner and intermediate kept the same 40–60 concepts). Lessons stay grounded in the sources (PRD: the LLM's own knowledge only connects and explains)

**L-10 · Curio teaches: streamed teaching lessons + a tutor per module, resources become citations (Phase 9)**
- **How:** opening a module streams its lesson (no button). One section per concept: intuition → precise idea (cited) → worked example (runnable code for technical topics) → misconception → key takeaways. Factual claims are cited; examples, analogies and code are the teacher's own and must agree with the sources. A concept with nothing relevant in the sources (the model's own list, L-09, or a gap prerequisite) is taught briefly under *"General knowledge, not in the resources"*, never cited. The tutor is the lesson-scoped chat with the lesson, module and path in context; it stays on the module's topic and only **suggests** marking done (the learner clicks, since done writes `UNDERSTOOD` memories). One classroom screen; the resources sit in a collapsed "What your teacher studied"
- **Alternatives:** lessons as summaries + links (the Phase 8 outline felt like "a list of links to go and read"); writing lessons from search snippets (notebookLmPlus, ~2.5k chars per source); skipping uncovered concepts (holes in the lesson); the tutor marking done itself
- **Why:** owner (2026-10-03): Curio should study the resources and teach. Full ingestion and the tested retrieval keep the facts grounded; examples are what make a lesson click and can't come from the sources. Faithfulness is judged on factual claims only, so the metric still means "nothing invented"

**L-11 · Scope check before a path; module time computed in code (Phase 9)**
- **How:** `GET /learning-paths/scope` (one Luna call) → too broad → 4–6 narrower topics as options; failure → not broad. The order step adds `why` + relative difficulty per module and sizes the module count to the topic's breadth (still 3–10). Minutes = included concepts × `minutesPerConcept[level]` after the cut
- **Why:** a goal like "programming" makes a shallow path; one question up front fixes that. A model's minute estimate is made before the cut drops concepts, so it would be wrong; the code number always matches what is taught (L-02)


**L-12 · Lessons stay on Luna (9.7)**
- **Why:** the 9.7 eval (`evals/results/2026-10-04-lessons.json`, 6 lessons, Python + Git): lesson faithfulness **0.936** (171 claims, 11 unsupported: motivation lines and basics the passages didn't spell out; nothing invented about how the tools behave), every lesson with worked code, a misconception and takeaways, ~$0.003 a lesson. Sol (~20× the price) has little room to improve that (A-08: upgrade only if evals show the need)
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

**M-06 · Extraction output is screened in code, not just by the prompt** (2026-10-03, 7.4)
- **Rule:** a proposed memory is dropped if it shares a run of 8+ words with an answer in the scanned messages (answers are built from the sources), is over 300 characters, updates an unknown or `USER_EDITED` memory, is a `TOPIC` fact in a notebook without a topic, or duplicates an existing memory; at most 5 new per run. Chat extraction writes only `STYLE` / `GOAL` / `FACT`
- **Why:** "facts about the learner only, never source content" (PRD §5.8) must hold even when the model slips; the check is deterministic and testable
- **Trade-off:** a learner fact that happens to repeat 8 words of an answer is lost; the next mention can add it

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

**O-04 · Luna judges Luna's answers** (changed 2026-10-01, owner; was: Sol judges)
- **Why:** Sol cost ~25× Luna per token and was ~97% of every eval run's LLM bill; Luna at medium reasoning effort is enough to check claims against cited text and score against an expected answer
- **Trade-off:** a model grading its own tier can be lenient with its own mistakes. Mitigated by fixed judge prompts, citation accuracy and refusals measured in code, and the ablation comparing configs under the **same** judge (absolute numbers matter less than the differences). Every config is re-run with the Luna judge, so no Sol-judged number is compared with a Luna-judged one

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

**PR-06 · Tests run on a local Postgres in Docker, not the Neon `test` branch** (2026-10-03, owner)
- **Alternatives:** keep the Neon `test` branch; switch tests to the `pg` driver
- **Why:** every query crossed the internet, so the server suite took ~25 min; locally it takes ~25 s (582 tests). Neon's `wsproxy` container lets tests keep the production Neon driver
- **Trade-off:** Docker Desktop must be running for integration tests; local Postgres 17 may differ slightly from Neon's

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
| 3 | Transcript API vendor → **Supadata** (decided 2026-09-30) | I-12 |
| 6 | Reranker: Cohere vs Jina | R-09 |
| 6 | HyDE: kept or dropped (with numbers) | R-10 |
| 6 | Chunk size after tuning | I-14 |
| 6 | Relevance gate threshold | R-11 |
| 9 | Lessons: Luna enough, or upgrade to Sol? → **Luna** (decided 2026-10-04) | L-12 |
