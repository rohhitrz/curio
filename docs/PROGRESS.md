# PROGRESS — Curio

> Updated by the agent in the same commit as each completed step.
> Read this first in every new session.

## Current status
- **Phase:** 9 (Lessons), in progress
- **Current step:** Phase 9 doc changes approved by the owner and committed (2026-10-04)
- **Blocked on:** nothing
- **Next step:** 9.1 migration `0011_lessons`
- **Deferred work** (not in any phase) is listed in `docs/todo-v2.md`; add to it whenever something is left for later.

## Phases
| # | Phase | Status |
|---|---|---|
| 0 | Foundation | ✅ Done (owner approved) |
| 1 | Auth + notebooks + first deploy | ✅ Done (owner approved) |
| 2 | Sources (no processing) | ✅ Done (owner approved) |
| 3 | Ingestion pipeline | ✅ Done (owner approved) |
| 4 | Eval foundation | ✅ Done (owner approved) |
| 5 | Basic RAG chat | ✅ Done (owner approved) |
| 6 | Advanced retrieval | ✅ Done (owner approved) |
| 7 | Memory | ✅ Done (owner approved) |
| 8 | Learning paths | ✅ Done (owner approved) |
| 9 | Lessons | 🔨 In progress |
| 10 | Hardening | ⏳ Not started |
| 11 | Final evals + polish | ⏳ Not started |

Status values: ⏳ Not started · 🔨 In progress · ✅ Done (owner approved)

## Current phase steps: Phase 9
- [x] 9.0 Doc changes from the owner's teacher feedback (approved 2026-10-04): PRD 5.6–5.7 + flow B, system design §8–9 (teaching lessons, tutor), DB (`modules.why` / `difficulty`, `path_resources.mapped_at`, tutor lookup), API (scope check, resource states in the poll, module why / difficulty / minutes, lesson `conversationId`, `action` stream event), build plan Phase 9 (9.1–9.7), test plan, decisions L-10 + L-11 · owner's picks: uncovered concepts taught under "General knowledge, not in the resources"; the tutor only suggests mark done
- [ ] 9.1 Migration `0011_lessons`: `lessons` + FK/index `conversations.lesson_id`, `modules.why` + `difficulty`, `path_resources.mapped_at`
- [ ] 9.2 Path upgrades: order `why` + difficulty + breadth-sized modules · minutes in code · `mapped_at` + resource states · scope check
- [ ] 9.3 Lesson pipeline (retrieval per concept → teaching prompt → citation check → stream → save; versions, lock)
- [ ] 9.4 Lesson API + `PUT /completion` with `UNDERSTOOD` memories
- [ ] 9.5 Tutor (lesson-scoped chat with path context, on topic, suggests done)
- [ ] 9.6 Frontend: scope options, progress with resource names, outline additions, classroom
- [ ] 9.7 Eval: lesson faithfulness
- [ ] 🛑 Owner approves Phase 9

## Phase 8 steps (done)
- [x] 8.1 Migration `0010_learning_paths` (enums `goal`, `path_status`, `resource_role`, `resource_type`, `concept_status`; tables `learning_paths` (one per notebook), `path_resources`, `modules` (unique `(path_id, position)`), `concepts` (indexes `(path_id)`, `(module_id, position)`), `concept_coverage` (PK `(concept_id, path_resource_id)`); plus the deferred FK `memories.concept_id → concepts.id ON DELETE SET NULL`) on dev + test · shared `learning.ts` (enums, `pathHookSchema`, `branchOptionsSchema`) · `level` enum moved to `db/schema/level.ts` (memories ↔ learning paths would import each other)
- [x] 8.2 Tavily provider `lib/search/` (`SearchProvider.search` → title / url / snippet / score; `SearchError` retryable on timeout, network, 429, 5xx; `webSearch` config: 15s, `basic` depth) · `GET /learning-paths/prefill?topic=` (`learning-paths` route → controller → service): user has no levels → `null` without an embedding call; same normalized topic with a level → `EXACT`; else the nearest of the user's levels by topic-name cosine ≥ `learningPaths.relatedTopicMinSimilarity` (0.6) → `RELATED` (known topic → stored embedding; unseen topic → embedded, **not created**: the endpoint is read-only); embeddings down → `null` · repo: `memories.levels`, `memories.nearestLevel`, `topics.findWithEmbedding` · shared `prefillQuerySchema` / `prefillResponseSchema`
- [x] 8.3 `generateLearningPath` job (`path/requested`), part 1: `claim` (only a `GATHERING` path) → `search` (3 searches via Tavily, Firecrawl search as fallback; some failing is fine, all failing retries then `SEARCH_FAILED`) → `select` (Luna `resourceSelection` judges every result; pure `selectResources` picks 1 `OFFICIAL` + ≤ 5 `POPULAR`, ≤ 1 video, one per site; model down on the last attempt → search order; < 3 → `NO_RESOURCES`) → `save-resources` (one transaction: sources `LEARNING_PATH`/`PENDING` + `path_resources`, status `READING`; a page already in the notebook is reused) → `step.invoke(processSource)` per source, in parallel → `finish-reading-N` (sources still in flight: `step.sleep` 1m, up to 10×) → `MAPPING`, or `TOO_FEW_RESOURCES` with the count · retry reuses saved resources (no search), resets `FAILED` sources · `onFailure` → `GENERATION_FAILED` · decision L-06 · `TAVILY_API_KEY` required at boot
- [x] 8.4 Part 2 (decision L-07): `list-read` → `map-<resourceId>` per read resource in parallel (Luna `conceptMap`; last-attempt failure leaves the resource out) → `merge` (< 3 mapped → `TOO_FEW_RESOURCES`; Luna `conceptMerge`, pure `applyMerge` + `consensusScore`) → `order` (Luna `learningPath`, pure `applyOrder`: modules, ≤ 3 gaps, branches) → advanced: `offer-branches` (`AWAITING_BRANCH` + `branch_options`) then `waitForEvent('path/branch-selected', match data.pathId)` in 1h slices × 72, re-reading `selected_branch` after each (`BRANCH_NOT_PICKED` after) → `build` (`BUILDING`, pure `cutPath`) → `hook` (Luna `pathHook` from the official resource's opening; failure → none) → `save` (one transaction: modules, concepts with status/reason/position, coverage, hook → `READY`) · every status move is safe to repeat
- [x] 8.5 API (`learning-paths` route → controller → service → repository): `POST /learning-paths` (rate limit 5/day; topic `findOrCreate`; one transaction: `LEARNING` notebook within the notebook cap + path + `LEVEL` memory via `upsertLevelIn` (extracted from the memories repository); `path/requested` not sent → `FAILED` at once) · `GET /learning-paths/:id` · `POST /:id/branch` (409 `INVALID_STATE` / 400 not offered; pick saved, then `path/branch-selected`) · `POST /:id/retry` (only `FAILED`; reset to `GATHERING`, not rate-limited) · `GET /:id/outline` (409 `PATH_NOT_READY`; modules + concepts with `coveredBy` / `officialCovers`, skipped, resources, progress) · `PATCH /modules/:id` `{ isEnabled }` · notebook detail `learningPathId` wired · shared schemas in `learning.ts`
- [x] 8.6 Frontend (`features/learning/`): `/learn` clarify screen (topic, level and goal as card radios; prefill looked up 0.5s after typing, pre-selects the level with a "Still right?" note until the learner picks) → `POST` → `/learn/[pathId]`: progress stages (polled every 2s until `READY` / `FAILED` / waiting on the learner; again after a branch pick), branch picker, failure with "Try again" (retry), outline: hook, modules with checkboxes (optimistic `PATCH`), concepts with "why is this here?" (coverage evidence), "Skipped for now" with reasons, resources · "Learn" in the header, "Learn a topic" on the notebooks page, "Learning path" link on a learning notebook · pure helpers in `display.ts` (tested)
- [x] 8.7 Evals: `pnpm eval:paths` (coverage by judge vs hand-listed core sections, consistency = Jaccard across runs) · fixes it drove: official docs read as a section (L-08), map budget shared per page, cut floor 20 / 16, the model's own knowledge as a vote (L-09), merge groups a concept with its kinds · **no committed full-run numbers**: the owner skipped the full run; numbers below are from partial runs
- [x] 🛑 Owner approves Phase 8 (2026-10-04: "approved")

## Phase 7 steps (done)
- [x] 7.1 Conversation summary: `summarizeConversation` job (`conversation/summarize`, `inngest/summarize-conversation.ts`) → `conversation-summary.service.ts` (`draft` then `save` as two steps, so a failed save doesn't repeat the model call) · pure `pipelines/memory/summarize.ts` (Luna `conversationSummary`, old summary + new messages, markers stripped, failed answers left out) · optimistic save (`WHERE summarized_through_seq = old`, scoped by user; 0 rows → `superseded`) · chat queues the job after a saved answer when more than `conversation.summarizeAfterMessages` (20) messages sit outside the summary; queueing failure only logs · prompt = summary + last `recentMessages` (10) · traced as `conversation-summary`
- [x] 7.2 Topics: `topics.service.ts` `findOrCreate` (normalized name = NFKC + lower case + single spaces; found → reused, no embedding call; new → name embedded once, `insertOrGet` with `ON CONFLICT (normalized_name) DO NOTHING` so parallel creates make one row, first wording kept; synonyms stay separate) · `PATCH /notebooks` `{ title?, topic? }` (`topic: null` clears; topic resolved before the update, so embeddings down → 503 and nothing changes) · notebook responses carry `topic: { id, name } | null` (API doc updated) · no migration (`topics` + `notebooks.topic_id` exist since 0002)
- [x] 7.3 Migration `0009_memories` (enums `level`, `memory_scope`, `memory_kind`, `memory_origin`; checks: `scope = 'TOPIC'` ⇔ `topic_id` set, `LEVEL` ⇒ level + `TOPIC`; partial unique indexes: one `LEVEL` per (user, topic), one `UNDERSTOOD` per (user, concept); index `(user_id, scope, topic_id)`) on dev + test · `memories.repository.ts`: `list` (scope / topic / since, topic name joined), `findById`, `count`, `insertWithinCap` + `upsertLevel` (per-user advisory lock, cap `quotas.memoriesPerUser` = 200; updating an existing level works at the cap), `update` (`unlessUserEdited` for the extraction job), `delete`, `deleteAll`; all scoped by user
- [x] 7.4 `extractMemories` job (`memory/extract`, one run per user at a time): `draft` (Luna `memoryExtraction` structured output over the messages after `memory_extracted_through_seq`, with the learner's `STYLE`/`GOAL`/`FACT` memories, global + the notebook's topic, user-edited ones marked read-only) → pure `screenOperations` (decision M-06) → `apply` (adds via `insertWithinCap` with `CHAT_EXTRACTED`, `origin_ref` = conversation; updates with `unlessUserEdited`; then the marker moves, optimistic) · chat queues it after a saved answer when more than `memoryExtraction.afterMessages` (6) messages are unscanned · traced as `memory-extraction`
- [x] 7.5 Memory in prompts: `memories.forNotebook` (global + the notebook topic's memories, one query) → pure `formatLearnerProfile` (`pipelines/memory/profile.ts`: levels, style, goals, background, understood; cut to `learnerProfile.maxMemories` 30 / `maxChars` 2000) → first turn of the answer and reply prompts ("About me, the learner… not a source of facts"), apart from the sources so it can't be cited; one rule added to `CHAT_ANSWER_INSTRUCTIONS` and `CHAT_REPLY_INSTRUCTIONS` · loaded in parallel with the history; failure → answer without it (logged) · trace output `profile: true/false`
- [x] 7.6 Memory API: `GET /memories` (`?scope`, `?topicId`, `?since`; topic + server-built `originLabel`), `PATCH /memories/:id` (`content` / `level`; any edit → `USER_EDITED`; `level` on a non-`LEVEL` memory → 400), `DELETE /memories/:id`, `DELETE /memories` · shared schemas `packages/shared/src/memories.ts` (`MEMORY_CONTENT_MAX` 300, also the extraction limit) · web: `/memories` page ("About you" + one section per topic, edit / delete / delete all with confirm; "Memory" in the header) · "Noted" notice in the chat: after each answer, `GET /memories?since=` at ~6s and ~20s; new `CHAT_EXTRACTED` memories show with a link to the page
- [x] 🛑 Owner approves Phase 7 (2026-10-03: "start with phase 8")

## Phase 6 steps (done)
- [x] 6.1 Feature flags through the pipeline: `pipelines/retrieval/pipeline.ts` `runRetrieval` (understand → vector (+ keyword) search per query → RRF fusion when there is more than one list → rerank → top `rerankTopK`), each step behind its flag in `config/flags.ts`, injected as optional deps (flag on without its dep throws) · RRF in `fusion.ts` (`retrieval.rrfK` = 60) · chat traces each step as a span under `retrieve` · eval runner uses `runRetrieval`, `--flags=a,b` for ablations, `-retrieval` suffix on retrieval-only results
- [x] 6.2 Query understanding: `pipelines/retrieval/understand.ts` (one Luna `generateObject`: `needsRetrieval`, `standaloneQuery`, `subQueries` ≤ `retrieval.maxSubQueries`; last `understandingHistoryMessages` of history) · failed call → raw question (`failed: ['understand']`, logged) · routed-out messages get a short `chatReply` with no sources · **eval: `queryRewrite` on** (`2026-10-01-vector+queryRewrite.json`) · eval runner retries a question after a retryable LLM error
- [x] 6.3 Keyword search: `keywordChunks` in `retrieval.repository.ts` (any word of the query via `plainto_tsquery` with `&` → `|`, `ts_rank`, same scoping as vector search, `retrieval.keywordCandidates` = 40; no migration, `search_vector` + GIN exist since 0005) · fused with RRF · **eval: `hybridSearch` on** (`2026-10-01-vector+queryRewrite+hybridSearch.json`)
- [x] 6.4 Rerank: Cohere provider (`lib/rerank/`) + `rerankChunks` (top 8, relevance 0–1 as the chunk score) · failure → fused order · **eval: `rerank-v4.0-fast` picked over pro** (R-04) · `rerank` flag **on** (owner's Trial key on Vercel as a Secret; `loadEnv` refuses to start with the flag on and no key)
- [x] 6.5 Relevance gate: top rerank score < `retrieval.relevanceThreshold` (0.70) → `chunks: []` → "not in your sources" without a model call; skipped when rerank didn't run; `relevanceGate` flag (needs `rerank`) · eval prints a threshold sweep (`gateSweep`) · **eval: gate on**, refusal accuracy 0.95 → 1.0, false refusals 0 (R-05)
- [x] 6.6 Citation check: `removeInvalidMarkers` (`citations.ts`) drops every `[n]` with no source the model saw, also inside groups; the saved answer is the checked text, so snapshots and text always agree (the live stream may still show an invented number for a moment: the web app already hides markers with no citation). Removed markers go to the trace output and each eval answer (`removedMarkers`). No eval in the build plan for this step
- [x] 6.7 Eval-gated trials: HyDE built behind the `hyde` flag (one more vector search with a hypothetical passage; failure skipped) + `--chunk-tokens` in the eval. **Not adopted** (R-09): retrieval is at the dataset's ceiling (MRR 0.983); the owner stopped the trial runs before they finished, so no result file
- [x] 6.8 Timeouts + degradation: `chatTimeouts` (understanding 3s and HyDE 3s via `withDeadline`, which aborts the call and rejects even if it hangs → skipped; question embedding 5s on its own client; `statement_timeout` 5s on both searches) · `serviceTimeouts` (Upstash 2s per request, R2 connect 5s / request 15s) · searches run with `allSettled`: vector down → keyword only, keyword down → vector only, both down → error · rerank down → fused order, gate skipped (6.4/6.5)
- [x] 🛑 Owner approves Phase 6 (2026-10-02: "Start Phase 7")

## Phase 5 steps (done)
- [x] 5.1 Migration `0008_conversations_messages` (on all three branches; prod run by the owner, 2026-10-01) · shared chat enums + `citationSnapshotSchema` in `packages/shared/src/chat.ts`
- [x] 5.2 LLM provider `lib/llm` (AI SDK + `@ai-sdk/openai`, Responses API: `gpt-6-luna` / `gpt-6.1-sol`, per-task output cap + reasoning effort, static instructions first + per-task `prompt_cache_key`, `store: false`, `LlmError` retryable or not) · tracing `lib/tracing` (`Tracer`: trace / span / score / flush over Langfuse's OpenTelemetry SDK; AI SDK calls land in the active trace; every string attribute cut to 500 chars). Not wired into `index.ts` yet (5.4)
- [x] 5.3 Generation in `pipelines/retrieval/` (pure): `buildContext` (dedupe, [n] numbering, `retrieval.contextMaxTokens` budget) · `prompt.ts` (static `CHAT_ANSWER_INSTRUCTIONS`, summary + history before the sources and question, old `[n]` stripped from history) · `citations.ts` (markers → snapshots via the shared schema) · `generateAnswer` (streams; no chunks → `NOT_IN_SOURCES_ANSWER` without a model call) · `test/fakes/llm.ts`
- [x] 5.4 Chat API: the 9 chat endpoints (`routes/chat.routes.ts` → `chat.controller` → `chat.service` → `chat.repository`) · streaming send/retry as AI SDK UI message SSE · Upstash busy lock (`lib/locks`) + rate limits (`lib/rate-limit`, chat 20/min + 200/day, source adds 50/day) · resend = no duplicate · continue on disconnect · retry replaces `ERROR` · feedback → Langfuse score · tracing + Upstash wired in `index.ts`; Langfuse/Upstash env vars now required
- [x] 5.5 Frontend (`apps/web/src/features/chat/`): chat beside sources on the notebook page · conversation picker, new chat, rename, delete · streamed answers with the status line · Markdown answers with `[n]` chips + a sources list under each answer · citations open PDF at the page (signed URL `#page=N`), YouTube at `t=`, website/text in the viewer with the passage highlighted · 👍 / 👎 · retry on a failed answer
- [x] 5.6 Eval runner: answer metrics (faithfulness and correctness by the judge, `evals/judges/`; citation accuracy and refusals in code), 2 runs averaged, cost per model · LLM provider `generateObject` (schema-checked JSON) · full baseline `evals/results/2026-10-01-vector.json` (commit `d0ff7d3`)
- [x] 🛑 Owner approves Phase 5 (2026-10-01: "Start Phase 6")

## Phase 4 steps (done)
- [x] 4.1 Retrieval module v0 (pure, callable without HTTP): vector-only search, notebook filter, iterative scan enabled
- [x] 4.2 Golden dataset: 7 documents (all types), 60 answerable questions + 10 unanswerable in `evals/dataset/`
- [x] 🛑 Owner reviews and fixes the dataset (owner spot-checked a sample and approved it as is, 2026-09-30)
- [x] 4.3 Eval runner (`pnpm eval`): hit rate@k + MRR, JSON to `evals/results/`
- [x] 4.4 Run and commit the baseline (`evals/results/2026-09-30-vector.json`, from `dc908a9`)

## Phase 3 steps (done)
- [x] 3.1 Inngest client + signed `/api/inngest` endpoint + local dev server; adding a source sends `source/created` (live, `d53cff3`)
- [x] 3.2 Extractors behind providers: `unpdf`, Firecrawl, Supadata, text; each failure classified transient or permanent with a user-facing message. Not wired into the app yet (that is 3.5)
- [x] 3.3 Chunking module (pure): `pipelines/ingestion/chunk.ts`, tokens counted with `gpt-tokenizer`
- [x] 3.4 Migration `0005_source_chunks` (applied on all three branches); OpenAI embeddings provider (batched)
- [x] 3.5 `processSource` job: 4 Inngest steps (mark processing → extract → chunk → embed + atomic commit), idempotent, classified failures, stops when the source is gone (live)
- [x] 3.6 Sweeper cron (every 5 min) · `POST /sources/:id/reprocess` · `GET /sources/:id/content` + `/chunks` · `notebook/deleted` R2 cleanup job
- [x] 3.7 Frontend: failure reason + Retry button, "Process again", viewer with Text and Chunks tabs ("Show in text" highlights a chunk's passage)

## Resume here: Phase 8
- **8.1 notes:**
  - `branch_options` is an array of `{ name, description }` (the doc only says the pick must be in it; the picker needs a line per branch). `POST /branch` matches on `name`. `03-database-design.md` updated.
  - `consensus_score` is `numeric` read as a JS number (`mode: 'number'`).
  - Added `path_resources (path_id)` index (FK lookups; listed in `03-database-design.md`).
  - `0010_learning_paths` run on prod by the owner (2026-10-03).
- **8.2 notes:**
  - `TAVILY_API_KEY` is required at boot since 8.3 (owner added it on Vercel, 2026-10-03).
  - The 0.6 threshold was set without real embeddings (tests use chosen vectors; no API calls). **Check live** that e.g. "Deep Learning" offers a "Machine Learning" level and an unrelated topic doesn't; tune in `config/limits.ts` if not.

- **8.3 notes:**
  - **The learning notebook is not created by the job:** `POST /learning-paths` (8.5) creates notebook + path + `LEVEL` memory in one transaction (API doc), so the job adds the sources to that notebook. The build plan's "create notebook" step is that.
  - **Ingestion = `step.invoke(processSource)`** with `data: { sourceId, userId }` (the invoked run parses `event.data` like a `source/created` run). Invoke failures/timeouts (30m) are caught: the DB says what was read. Learning sources are `PENDING` with no `source/created` event; if the sweeper re-sends one first (> 10 min pending), its run owns the source and the invoked one stops `not_pending` → the `finish-reading` re-checks cover that.
  - Retry (8.5): the endpoint must set the path back to `GATHERING` (clearing the error) and send `path/requested` again; the job sees saved resources and skips search + select.
  - Duplicate `path/requested` for one path: the second run stops at `claim` once the first moved past `GATHERING`; per-user concurrency 1 keeps them from running steps at once. Good enough while only our API sends the event.
  - Not done: "Tavily reads when Firecrawl fails" (the scraping side of the fallback; `processSource` change) → `docs/todo-v2.md`.
  - `resourceSelection` is traced as `learning-path-selection`. Search and selection make real API calls only in the deployed job (none in tests).
  - **Inngest:** resynced after the push of `85e67dd` (2026-10-03, `modified: true`); Vercel deploy READY, `/health` ok (boots with `TAVILY_API_KEY`).

- **8.4 notes:**
  - **Repeated steps:** a step can run twice (Inngest delivers at least once; the test engine runs parallel steps' re-executions concurrently, which is how this showed up). Every status move re-reads the path when it doesn't apply and carries on if a repeat got there first; `saveOutline` on a `READY` path is a no-op. A first version stopped such runs as `not_found`.
  - The branch endpoint (8.5) must save `selected_branch` (status `AWAITING_BRANCH`, name in `branch_options`) **before** sending `path/branch-selected { pathId, userId }`: the job reads the pick from the database, the event only wakes it. A pick sent just before a wait starts is caught by the next slice's re-read (≤ 1h).
  - Integration: beginner end to end with fakes (concepts, coverage, modules, hook), advanced pause + resume (only the branch kept), no pick in time, 2 / 4 resources unmapped, hook down, merge down. Waits are injectable (`waits`), so the test uses 3 branch slices instead of 72.
  - No real LLM calls (none in tests, and no eval in this step: 8.7 is the eval).

- **8.5 notes:**
  - The `LEVEL` memory reads "intermediate in Deep Learning" (`content`); the profile shows `level` + topic anyway. `origin_ref` is the path.
  - "Start path, DB fails midway" is tested with a temporary trigger that makes the memory insert fail: no notebook, no path, no event.
  - The outline's resources carry `url` too (the API doc example didn't; doc updated).
  - Rate limiting is per request like sources (a rejected start still counts).

- **8.6 notes:**
  - Checked by typecheck, web tests (86) and `next build` only: the agent can't sign in (Clerk is hosted), so **the owner checks the screens live** (Pending on owner).
  - "Start learning" opens the path's notebook (lessons per module come in Phase 9).

- **Owner feedback on the first live path (2026-10-03), for Phase 9** (owner: "first complete phase 8, then Phase 9 in another chat"):
  - The path page feels like a list of links to go and read. The owner wants a **teacher**: Curio studies the resources itself, then teaches; the learner shouldn't need to open the links.
  - Reference: the owner's own repo `github.com/rohhitrz/notebookLmPlus` (Learn mode: `lib/learn.ts`, `lib/chapters.ts`, `components/learn/`). Ideas to bring into Phase 9 (propose doc changes first): (1) lessons stream on opening a module, sources only as citations; (2) lesson prompt that teaches: intuition first, a worked example after every idea, runnable code for technical topics, misconceptions, "Key takeaways"; (3) a tutor chat per module that stays on its topic, knows sibling modules' summaries, and can mark the module done; (4) a scope check before building: a too-broad goal gets 4–6 focus options; (5) modules show why / difficulty / minutes, count sized to the topic's breadth; (6) one classroom screen (modules left, lesson + tutor right), resources demoted to a collapsed "What your teacher studied", "Start learning" opens the first lesson.
  - Keep Curio's strengths: full ingestion of each resource (notebookLmPlus writes from ~2.5k-char search snippets), consensus-based outline, lessons grounded via the tested retrieval.
  - Also: the progress screen should say which resource is being mapped (the mapping stage looked frozen; it was working).

- **8.7 notes (in progress, not pushed):**
  - `pnpm eval:paths` (`evals/scripts/run-path-eval.ts`): gathers + reads once per topic on dev (real Tavily / Firecrawl / Supadata / OpenAI), then builds beginner + intermediate × `--runs` (3) and advanced × 1 through the real services; coverage by judge (`judges/path-coverage.md`), consistency = pairwise Jaccard (exact names and embedding-matched ≥ 0.85). `--topics=`, `--runs=`, `--reuse`. A Python run with `--runs=1` costs ~$0.02.
  - Dataset `evals/dataset/paths.json` is a **draft**: Python (official tutorial), Git (Pro Git), French Revolution (no official docs, standard outline). **Owner to review.**
  - **Smoke runs found real problems** (Python, beginner coverage 0, intermediate 0.18–0.36): (1) gather picked navigation pages (python.org landing, docs.python.org index) as "official", which map to 0 concepts; fixed by aiming searches at tutorials and rejecting index/landing pages in the selection prompt (2nd run picked the real tutorial index); (2) single-page ingestion: the official tutorial index page is a table of contents, the content is on ~15 sub-pages, so it maps to few concepts. A real fix is crawling a few pages of the official docs (design change: needs owner approval); (3) the beginner cut keeps ≥ 0.5 consensus, which with 4–5 noisy resources leaves ~5 concepts; tune `cut` (e.g. relative to the top score, higher `minIncludedConcepts`) and re-measure.
  - Results file `evals/results/2026-10-03-paths.json` is from a smoke run (not the committed baseline).
  - **Owner's picks (2026-10-04):** crawl the official resource (up to ~8 pages of its docs section, existing Firecrawl provider; doc changes first) · cut: keep the thresholds, raise the floor per level.
  - **Official docs as a section done (L-08, owner approved the doc changes 2026-10-04):** the `OFFICIAL` website resource is saved with `metadata.sectionPages` (8); `extractWebsite` then scrapes the links in its main content that stay on the same host under its folder (pure `pipelines/ingestion/section.ts`: page order, no anchors / query / files / repeats), 4 at a time (`extraction.sectionConcurrency`), skips any that fail, joins all under their titles (`joinSection`), records `pagesRead`. Map: official resource gets `officialMapMaxChars` 120k and ≤ `officialMaxConcepts` 40 (`conceptMap` output cap 3k → 5k). Docs: 02 §6 + §8, 03 `sources.metadata`, 06 (unit + integration rows), 07 L-08.
  - **Re-measured (Python, `--runs=1`, fresh gather):** official docs read as 9 pages (233k chars). Beginner 0.09 → 0.64, intermediate 0.18 → 0.82. The missed sections were past the 120k map budget, so the budget is now shared fairly across pages (`fairShare` in `pipelines/learning/map.ts`, text read up to `mapReadMaxChars` 600k); same resources (`--reuse`): beginner 0.73, intermediate 0.73 (single runs are noisy). Still missed: collections, classes (the tutorial's classes chapter is link 9+, past `officialSectionPages` 8), I/O once.
  - **Firecrawl rate limit (owner decision):** the plan allows ~10 scrapes/min; a path is now ~14 scrapes in a burst. In the fresh run, w3schools got 429 three times in 8s and was not read, leaving 3 resources (the minimum). In the job, Inngest retries with longer backoff, but linked pages that get 429 are just left out, and paths for different users share the limit. Options: a paid Firecrawl plan, or retrying linked pages after a wait.
  - **Consensus with 3 mapped resources:** official weight 2 of 4 = 0.5, so every official-only concept passes both thresholds. Beginner kept 40 concepts, intermediate 61 with 0 skipped: the levels barely differ.
  - **Owner's answers (2026-10-04):** (1) no paid Firecrawl → linked pages that fail for now are retried once after 30s (`extraction.sectionRetryWaitMs`; L-08), and the eval waits 30s between extract retries; (2) use the model's own knowledge as well, official docs first → **L-09**: a `recall` step (Luna `conceptRecall`, ≤ 25 concepts, alongside the maps) is one more voter in merge, weight 1 (official 2, popular 1); it adds to scores only (no coverage rows, not a resource; skip reason "Not in the resources (general knowledge only)"; the web's "why is this here?" for 0 resources now says so); recall failing → resources alone; (3) no full eval run; commit and push.
  - **With L-09** (Python, `--reuse --runs=1`): intermediate 0.91 / 0.64 / 0.73 over three runs with ~40 concepts; beginner 0.45 with 11–20 concepts. Beginner floor raised to 20, ties added back by place in the path. The eval file now records `recalled` and `skippedConcepts` (score, resources, fromModel).
  - **Next fix: merge granularity.** The model lists broad concepts ("Loops", "Lists"); the docs map finer ones ("For Loops", "Loop Control", "List Methods"). The merge rule "a concept and a part of it stay separate" keeps them apart, so beginner misses lists, loops and numbers (each at 0.4 from the docs alone, the model's at 0.2). Proposal: let merge group a concept with its kinds / forms (for loops are loops), keeping components separate (activation functions aren't neural networks); re-measure.
  - **Merge granularity done (owner approved 2026-10-04):** `CONCEPT_MERGE_INSTRUCTIONS` now groups a concept with its kinds, forms and basic uses ("Loops" with "For loops", "Lists" with "List methods"), keeps apart a different idea it is built from or used with, and keeps apart when unsure (L-07 updated). Python, same resources (`evals/results/2026-10-04-paths.json`, `--runs=1`): **beginner 0.45 → 0.82** (20 concepts: strings, operators, loops, lists, functions, modules, exceptions, files), intermediate 0.73 (27). Still missed: collections (tuples / sets / dicts) and classes (the tutorial's classes chapter is link 9+).
  - **Full run, partial (2026-10-04, printed only, no results file):** the first run crashed on a dropped Neon connection during Git (the runner doesn't retry DB errors; results are written only at the end); the `--reuse` rerun was stopped by the owner ("skip"). Python, 3 runs each over two runs: beginner 0.64 / 0.64 / 0.73 / 0.64 / 0.73 / 0.64, intermediate 0.82 / 0.82 / 0.73 / 0.82; Git beginner 0.46 / 0.36 / 0.46, intermediate 0.55. No consistency number and no French Revolution (topic without official docs) run yet. Committed result files are single smoke runs (`2026-10-03-paths.json`, `2026-10-04-paths.json`).
  - **Left for later (todo-v2):** runner should write results per topic and retry transient DB errors; the full run for consistency + the no-official-docs topic; the owner hasn't reviewed `evals/dataset/paths.json`.
  - The cut-floor commit broke 4 tests in `generate-learning-path.test.ts` (only unit tests were run for it): the job test now pins the floor to 5 so its 11-concept fixture still tests the thresholds.
  - **Cut floor done:** `beginnerMinConcepts` 10 / `intermediateMinConcepts` 16 (was `minIncludedConcepts` 5 for both; L-07 updated). Re-measured on the same Python resources (`--reuse --runs=1`): beginner 0 → 0.09, intermediate 0.18 → 0.18. Every included concept comes from intro pages (interpreter, print, variables, operators); strings, lists, loops, functions, modules, exceptions, classes are in **no** resource, so depth is the limit, not the cut.

## Phase 7 notes
- **7.1 notes:**
  - The job summarizes seqs `(summarized_through_seq, lastSeq − 10]`; the last 10 go to the prompt word for word, so nothing is sent twice. Between runs up to ~10 messages sit in neither (the documented ~20 / ~10 thresholds); fine for now, revisit if long chats lose the thread.
  - The job re-checks the threshold itself, so duplicate events (one per answer until the job runs) end as `up_to_date` without a model call.
  - Only COMPLETE messages are summarized; a range with only failed answers moves the marker without a model call.
  - **Inngest:** registered on 2026-10-03 with the runbook's `curl -X PUT …/api/inngest` (the deploy alone did not sync it).
  - Vercel's non-strict build reads a parsed `z.string().nullable()` as optional: the job rebuilds the draft field by field before `save` (`typecheck:vercel` caught it).

- **7.2 notes:**
  - Topics are shared and hold no personal data, so `topics.repository` queries take no user ID; the notebook update is still scoped by user (others' notebooks → 404, checked before a topic is created).
  - Topic embeddings use the chat embeddings client (5s timeout). No related-topic search yet: the similarity lookup arrives with the level pre-fill (Phase 8). No UI to set a topic yet (not in 7.2); learning notebooks will get theirs from `POST /learning-paths`.

- **7.6 notes:**
  - The memory page and the notice were checked by build + unit tests only: the agent can't sign in (Clerk is hosted), so **the owner checks them live** (see Pending on owner).
  - The notice starts its `since` one minute before the chat opened (client clock skew), so a memory noted just before can show once.
  - `POST /memories` (manual add) stays post-launch (API doc).
- **Phase 7 "done when"** (build plan): a long chat stays coherent (summary, 7.1) · stated preferences appear as memories (7.4) · user edits survive extraction (7.3/7.4/7.6, tested) · memories never appear as citations (7.5, tested) · tests pass ✅ (751). The first two need the owner's live check.
- **7.5 notes:**
  - The answer instructions changed (one line about the learner note). The eval runs without memories, so no eval was run for this step (none in the build plan); the next full eval (Phase 11) will use the new text.
  - "Memories never appear as citations": the profile is not a numbered source, and the citation check (6.6) drops any marker the model points at it (tested).
- **7.4 notes:**
  - "Source-like text rejected" (test plan) had no mechanism in the docs: it's the 8-word-run check against the scanned answers (M-06, `memoryExtraction.sourceOverlapWords`), plus the prompt rule.
  - `LEVEL` and `UNDERSTOOD` are never written by chat extraction (direct events only, Phase 8).
  - A re-run of `apply` after a partial failure skips adds whose text already exists; updates are idempotent. The marker moves even when the cap stopped adds, so old messages are never re-read (deleted memories stay deleted).
  - Dropped operations are logged with reasons only (the text is about the learner).
  - **Inngest:** registered on 2026-10-03 with the runbook's `curl -X PUT …/api/inngest` (`modified: true`). Pushes don't sync Inngest: the agent runs the PUT after every push that adds or changes a job.
- **7.3 notes:**
  - `memories.concept_id → concepts.id ON DELETE SET NULL` was added by `0010` (8.1).
  - `memories.topic_id → topics` is `NO ACTION` (topics are never deleted).
  - `0009_memories` run on prod by the owner (2026-10-03).
  - `level` now lives in `db/schema/level.ts` (moved in 8.1).

## Phase 6 notes
0. **6.1 notes (read before 6.2).** For Phase 6 read `02-system-design.md` §7, `07-decisions.md` R-01–R-08 and the Phase 6 rows of `06-test-plan.md`.
   - `runRetrieval` (`pipelines/retrieval/pipeline.ts`) is the one entry point for chat and the eval; `retrieve` is now just the vector-search half. With every flag off it is the vector baseline (same top chunks, cosine scores kept since fusion doesn't run on one list).
   - Flag → step: `queryRewrite` or `subQueries` turns on the understanding call; `queryRewrite` searches `standaloneQuery` (blank → raw question) **and owns routing** (`needsRetrieval: false` → `retrieved: false`, no search); `subQueries` adds one search per sub-query (deduped against the main query). `hybridSearch` adds `keywordSearch` next to each vector search. `rerank` reorders the fused candidates; off → top `rerankTopK` in fused order. `hyde` is not wired yet (6.7).
   - Steps to build plug in as deps: `understandQuery` (6.2), `keywordSearch` returning `RetrievedChunk[]` (6.3; RRF already exists, so 6.3 is the search + repository + eval), `rerank` (6.4). Wire each in `create-app.ts` **and** `evals/scripts/run-eval.ts`.
   - Chat now asks vector search for `vectorCandidates` (40) and keeps 8 (was 8 directly); same results, since search is exactly ordered.
   - Eval: `pnpm eval -- --flags=queryRewrite` etc. for ablations; the label and `config` in the results file come from the flags actually used. Each question records the `queries` it searched.
   - 6.1 has no eval in the build plan; no eval run was made (no LLM call). The vector config is unchanged, so `2026-10-01-vector.json` stays the baseline.
   - **6.2 notes:** `queryRewrite` is **on** in `config/flags.ts` (so live chat makes one extra Luna call per message); `subQueries` stays off until its turn in the ablation (after rerank). `createTestApp` defaults to **every flag off** so flipping a flag never changes unrelated tests; tests opt in with `flags`. The answer prompt still gets the user's own words; only search uses the rewrite. `generateAnswer({ retrieved: false })` → `chatReply` task (`CHAT_REPLY_INSTRUCTIONS`: one or two sentences, no facts). In the eval no question was routed past retrieval.
   - **6.3 notes:** keyword rows (`KeywordMatch`, with `textRank`) become `RetrievedChunk`s in the pipeline; after fusion every chunk's `score` is its RRF score, so **the relevance gate (6.5) can't use these scores**: use rerank scores. `createTestApp` keeps every flag off (tests opt in).
   - **6.4 notes:** rerank reads `contextHeader + content` (same as embeddings); its query is the rewritten one. The eval paces rerank calls to 10/min (`evalConfig.rerankCallsPerMinute`) because the local key is a **Trial key**: a first pair of runs lost 12 of 70 questions each to 429s, which silently kept the fused order (discarded). With a Production key the pacing can go. For 6.5+, evaluate with `--flags=queryRewrite,hybridSearch,rerank` (rerank is off in the app config). Rerank lowers pro's refusal accuracy (0.85; fast 0.95): unrelated-but-close chunks reach the model, which is the gate's job (6.5).
   - **6.5 notes:** the gate needs rerank (wiring check throws otherwise) and is skipped when rerank fails, e.g. a 429 on the Trial key: then a weak match can reach the model, which still has the prompt rule. `gated` and `gateScore` are in the `retrieve` span and in each eval question (`rerankTopScore`). Gated questions get no chunks, so in the eval they count as retrieval misses; fine at 0.70 (none of the answerable ones are gated).
   - **6.8 notes:** timeouts live in `config/limits.ts` (`chatTimeouts`, `serviceTimeouts`). The pipeline reports every skipped step in `failed` (`understand`, `hyde`, `vectorSearch`, `keywordSearch`, `rerank`), logged as "retrieval step failed; skipped" and shown in the `retrieve` span. The answer stream itself keeps the 90s LLM timeout (it is streaming, not waiting). Ingestion keeps its own longer timeouts.
   - **Phase 6 "done when"** (build plan): ablation table ✅ (Eval results) · tests ✅ (checkpoint run) · **first token < ~3s in Langfuse: owner to check live** (rerank was added after the last live check).
   - **Judge is Luna** (owner, 2026-10-01, decision O-04). Never compare a Sol-judged result with a Luna-judged one.
   - **Timeouts (6.8):** the understanding call has only the general 90s LLM timeout. In the eval one Luna understanding call hit it (q-066, fell back correctly); chat needs a short per-step timeout (~2–3s) so a slow rewrite can't stall the answer.
   - Lesson-scoped chat (search only some sources, test-plan Phase 6 row) needs a `sourceIds` filter on both searches; it arrives with lessons (9.4).
1. **`conversations.lesson_id` has no FK yet:** `lessons` doesn't exist until Phase 9. The Phase 9 migration that creates `lessons` must add `conversations.lesson_id → lessons.id ON DELETE SET NULL` (03-database-design §5).
2. **5.2 notes:**
   - Owner chose the SDK route (2026-10-01): `ai`, `@ai-sdk/openai`, `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`, `@langfuse/vercel-ai-sdk`, `@opentelemetry/sdk-node`, `@opentelemetry/api`. `02-system-design.md` §2 now names OpenTelemetry.
   - `startLangfuseTracing` is process-wide (OpenTelemetry + `registerTelemetry`): call it once in `index.ts`. Use `exportMode: 'immediate'` on Vercel and `await tracer.flush()` before the response ends.
   - `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` and the Upstash pair are on Vercel `curio-server` (owner, 2026-10-01), so 5.4 can make them required in `config/env.ts`.
   - Langfuse's own `mask` only covers its input/output attributes; the AI SDK writes whole prompts into `gen_ai.*` attributes, so a span processor in front of the exporter cuts every string attribute (`tracing.maxTextChars`).
   - Sol is `gpt-6.1-sol` (owner's choice, 2026-10-01); Luna stays `gpt-6-luna`.
   - No real LLM or Langfuse call was made (CLAUDE.md); tests use a stub `fetch` and an in-memory span exporter. The first real call is `pnpm eval` in 5.6.
3. **5.3 notes:**
   - Markers with no matching source get no snapshot but **stay in the text**; removing them is the citation check (6.6). Refusal = the answer is exactly `NOT_IN_SOURCES_ANSWER` → no citations.
   - The relevance gate (6.5) isn't there yet: until then any retrieved chunks reach the model, and refusing relies on the prompt.
   - 5.4 wires it: `retrieve` (span) → `generateAnswer` (LLM call traced by the AI SDK) inside `tracer.trace`, with `countTokens` from `pipelines/ingestion/tokens.ts`.
4. **5.4 notes (read before 5.5):**
   - **Stream format** (`chat.controller.ts`): AI SDK UI message chunks. `start` (messageId = the answer's ID) → `text-start` → `data-status` (transient: "Searching your sources…", "Writing the answer…") → `text-delta`… → `data-citations` (snapshots) → `text-end` → `finish` (`messageMetadata.traceId`). On failure: `data-error` `{code, message}` + `error`, then `finish`. Schemas for the frontend: `chatStreamDataSchemas`, `chatMessageMetadataSchema` in `packages/shared/src/chat.ts`.
   - **Send body** is `{ id, content }` only (`sendMessageSchema` strips anything else, so a client-side history is ignored; test-plan row). 5.5 must send only the new message (AI SDK `prepareSendMessagesRequest`).
   - **Resend of the same `id`**: no new user message; a saved answer is replayed without a model call; a failed or missing answer is generated. The same id in another conversation → 409 `INVALID_STATE`.
   - **Retry** works when the last answer is `ERROR` or the last message is an unanswered question (a crash); anything else → 409 `INVALID_STATE`.
   - **Errors before streaming** stay JSON: 404, 409 `CONVERSATION_BUSY`, 429 `RATE_LIMITED` (+ `Retry-After`), 503 when Redis can't take the lock. If the rate-limit check itself fails, the request is allowed (logged).
   - **Titles:** new conversations are "New conversation"; the first answer renames it after the question (`conversation.autoTitleMaxChars`). `POST …/conversations` with any `lessonId` → 404 until Phase 9.
   - **Disconnect:** the handler awaits the whole run, and writes to a closed stream are dropped, so the answer is saved (tested locally with a real socket). On Vercel this depends on the function running until the handler finishes after the client leaves; **check once live** (send, close the tab mid-answer, reload: the answer should be there).
   - Feedback score: `user-feedback` (UP = 1, DOWN = 0), id `feedback-<messageId>`, so changing it overwrites; `null` deletes it.
   - Summary / memory thresholds (API doc steps 10) are Phase 7.
5. **5.5 notes:**
   - Owner chose `react-markdown` + `remark-gfm` for answers (2026-10-01); `02-system-design.md` §2 names it. `ai` is used in the web app only for its stream parser (`parseJsonEventStream` + `uiMessageChunkSchema`); `useChat` isn't used because errors before the stream are JSON, retry is its own endpoint and only the new message may be sent (`features/chat/use-answer-stream.ts`).
   - Logic lives in tested pure modules: `stream.ts` (chunk → answer state), `citations.ts` (targets, links, `[n]` → chips; markers with no citation are hidden), `display.ts` (saved messages + streaming turn).
   - A citation whose source was deleted or is being reprocessed only shows its saved snippet (with a notice).
   - Owner checked the live chat (2026-10-01): streamed answers, citations, Langfuse traces and feedback work.
   - `.claude/launch.json` `dev` passes `PORT=3000` to every process, so the API also tries port 3000; use the separate `api` + `web` configs.
6. Messages keep the client-generated id as their primary key, so "duplicate id = retry" is an insert with `ON CONFLICT (id) DO NOTHING` (tested).
7. The dataset is approved (owner spot-checked a sample). If a question later turns out wrong, fix `evals/dataset/questions.jsonl` and run `pnpm --filter @curio/evals check`.
8. On a new machine, `pnpm --filter @curio/evals fetch-docs` first: the documents live in the gitignored `evals/.cache/`.
9. 4.3 reuses `evals/src/` (document reader, chunking, question schema, relevance rule).
10. Tests use fake providers only; `pnpm eval` is the only thing that calls real LLM APIs, and only from 4.3 on.

## Pending on owner
- **Try a learning path live** (8.1–8.6 are deployed): Learn → a topic you know → level + goal → Build my path. Watch the stages (a few minutes), then check the outline: hook, modules, "why is this here?", the skipped list, unchecking a module, Start learning → the notebook with the resources as sources. Also try an advanced path (branch picker) and a topic without official docs (e.g. a history topic). The first real runs make real Tavily + OpenAI calls (one search set + ~10 Luna calls per path). Tell me what looks off; 8.7 measures coverage and consistency.
- **Phase 7 live check** (Phase 7 approved; still worth doing):
  1. Open a notebook with a READY source and chat 4+ exchanges, saying something about yourself in one of them (e.g. "I'm a nurse, keep answers short").
  2. Within ~20s of an answer after the 4th exchange, a "Noted: …" notice appears under the chat; the **Memory** page (header) lists it under "About you".
  3. Edit it on the Memory page (label becomes "Edited by you"), keep chatting: it's never overwritten. Delete one, delete all (confirm dialog).
  4. Ask follow-ups: answers get shorter/simpler, but citations still point only at your sources.
  5. Long chat (11+ exchanges): Langfuse shows a `conversation-summary` trace; follow-ups about early messages still make sense.
  6. Inngest dashboard: `summarize-conversation` and `extract-memories` have runs.
- **Phase 6 live check** (Phase 6 approved; still worth doing): ask a few questions on the live app, including a follow-up ("what are its disadvantages?") and something not in your sources (should say "not in your sources" right away); in Langfuse, a `chat` trace shows `understand` → `search` → `rerank` under `retrieve` and **time to first token under ~3s**; numbers in "Eval results so far" (ablation table).
- **Re-process the YouTube source that came out in Arabic** (Process again), now that transcripts ask for English.
- **Later:** swap Vercel `COHERE_API_KEY` for a Cohere Production key once other people use Curio (Trial keys: 10 calls/min, not for production; the variable name stays the same).
- **Live check of the run-ownership fix** (owner will do it later): add any source on the live app and confirm it reaches `READY`.
- The dataset review is done (owner spot-checked a sample; `pnpm --filter @curio/evals review` writes `evals/.cache/review.md` for any later check).
- Phase 3 approved on 2026-09-30 after the live checks (Inngest resynced; text, website and YouTube `READY`; scanned PDF → `FAILED`/`NO_TEXT` with Retry; notebook delete cleaned `curio-prod`; error-code list confirmed).
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
| Inngest | 3 | ✅ Keys in local `.env` and on Vercel (Production only); app `curio` synced in the Production environment (owner, 2026-09-30) |
| OpenAI | 3 | ✅ Key in local `.env` and on Vercel (Production); embeddings work live (first real run 2026-09-30) |
| Firecrawl | 3 | ✅ Key in local `.env` (works, smoke-tested) and on Vercel (Production) |
| Supadata (transcripts) | 3 | ✅ Key in local `.env` (`TRANSCRIPT_API_KEY`, works, smoke-tested) and on Vercel (Production) |
| Langfuse | 5 | ✅ Keys in local `.env` (`LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL`) and on Vercel `curio-server` (owner, 2026-10-01) |
| Upstash | 5 | 🔶 Redis database `curio` (AWS us-west-2, free plan, eviction off); `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in local `.env` (PING works, 2026-10-01) and on Vercel `curio-server` (owner, 2026-10-01) |
| Cohere / Jina | 6 | 🔶 `COHERE_API_KEY` in local `.env` (owner, 2026-10-01); no Jina key yet; not on Vercel |
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
- **Local DB** = Neon `dev` (`DATABASE_URL`). **Tests** = local Docker Postgres (`TEST_DATABASE_URL=postgres://curio:curio@localhost:5434/curio_test`; `pnpm db:test:up` / `db:test:down`, data in tmpfs so it's empty after every restart; decision PR-06). The old Neon `test` URL is kept in `.env` as `NEON_TEST_DATABASE_URL`, unused. `test/helpers/db.ts` `assertSafeTestDatabase` refuses when its host + database (ignoring `-pooler`, credentials, params) matches `DATABASE_URL`, `DATABASE_URL_UNPOOLED` or `PROD_DATABASE_URL`, at setup and before every truncate. Tables are truncated per integration file; integration files run serially, unit files in parallel (`pnpm test:unit` / `pnpm test:integration`). **Prod** = Neon `main`.
- **Migrations:** `pnpm db:generate --name=<x>` then `pnpm db:migrate` (dev) · `pnpm db:migrate:prod` (main); the test database is migrated by every integration run. `drizzle.config.ts` maps `DB_TARGET` dev/prod explicitly and fails on unknown targets. Current: `0000_enable_vector`, `0001_users`, `0002_topics_notebooks`, `0003_sources` applied on all three branches; `0004_sources_storage_key_unique` on all three (prod run by the owner, 2026-09-30); `0005_source_chunks` on all three (prod run by the owner, 2026-09-30); `0006_sources_extracted_locations` on all three (prod run by the owner, 2026-09-30); `0007_sources_processing_run_id` on all three (prod run by the owner, 2026-10-01); `0008_conversations_messages` on all three (prod run by the owner, 2026-10-01); `0009_memories` on all three (prod run by the owner, 2026-10-03); `0010_learning_paths` on all three (prod run by the owner, 2026-10-03). The agent can't verify production; prod runs are as reported by the owner.
- **Vercel `curio-server` env:** `DATABASE_URL` (Neon `main` pooled), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `NODE_ENV=production`, `CORS_ORIGINS=https://curio-web-theta.vercel.app` (Production + Preview, 2026-09-30), `LOG_LEVEL=info`, `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` + `OPENAI_API_KEY` + `FIRECRAWL_API_KEY` + `TRANSCRIPT_API_KEY` + `TAVILY_API_KEY` (Secret, Production only; all six are required at boot), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=curio-prod`. The server always reads `DATABASE_URL`; `PROD_DATABASE_URL` exists only in local `.env` for migrations.
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
  - `POST /sources` rate limit (50/day) is on since 5.4.
- **Jobs (3.1):**
  - `inngest` 4.x, behind `JobsProvider` in `lib/jobs` (`send(name, data)`, typed by `JobEvents`). Client ID `curio`. pnpm `allowBuilds` declines `protobufjs` (its install script only prints a version warning).
  - **Env:** `INNGEST_DEV` is `1`/`true`/`0`/`false` (unset = off). Without dev mode, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are required and the server refuses to boot. The client always gets `isDev` from our config, so the SDK never decides the mode from the environment itself.
  - **Endpoint:** `/api/inngest` is mounted before the general JSON parser with its own 4 MB limit (`requests.inngestBodyLimit`), outside `/api/v1` and user auth. In cloud mode the SDK answers unsigned or forged `GET`/`POST` with 401. An unsigned `PUT` only makes the SDK re-register this app with Inngest using our signing key (standard Inngest behavior). No functions are registered until 3.5.
  - **`source/created`** = `{ sourceId, userId }`, sent after the insert transaction commits. If the send fails, the request still returns 202 and the source stays `PENDING` (warn log `source/created not sent`); failing the request would make a retry hit 409. The 3.6 sweeper sends the event again.
  - Verified locally: the dev server synced the app (`PUT` 200) and received a `source/created` sent through the provider.
- **Extraction (3.2):**
  - **Layout:** providers in `lib/scraper` (Firecrawl), `lib/transcript` (Supadata), `lib/pdf` (`unpdf`); `StorageProvider.download(key)` returns the bytes or null. `pipelines/ingestion/extract.ts` `extractSource(source, deps)` picks by type and returns `{ title, content, metadata }`.
  - **Content shape** keeps each type's citation location: PDF → `pages[{ pageNumber, text }]` (empty pages kept so numbers stay right), YouTube → `segments[{ text, startSeconds, endSeconds }]`, website/text → `markdown`. How this is stored between job steps is decided in 3.5.
  - **Titles:** website and YouTube return the real title (replaces the placeholder); PDF and text return `null` and keep the user's title.
  - **Learned metadata:** PDF `pageCount` + `fileHash` (real SHA-256 of the file; the browser's hash is only a claim, and what to do on a mismatch is a 3.5 decision); YouTube `durationSeconds` + `language`.
  - **Errors:** everything thrown is an `IngestionError` (`errors/ingestion-error.ts`; renamed from `ExtractionError` in 3.4 because embedding uses it too) with `code`, `retryable` and a user-facing `message`; vendor detail goes in `cause` for the log only. **Source error codes:** `NO_TEXT`, `INVALID_FILE`, `FILE_MISSING`, `PAGE_NOT_FOUND`, `PAGE_BLOCKED`, `NO_TRANSCRIPT`, `VIDEO_UNAVAILABLE`, `VIDEO_TOO_LONG`, `SERVICE_UNAVAILABLE` (the only transient one), `PROCESSING_FAILED`, plus the sweeper's `TIMEOUT`. The list was added to `04-api-design.md` §4 in 3.7 (the UI shows the message, not the code); owner to confirm at phase approval.
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
  - **Heading fix (2026-09-30, found while building the 4.2 dataset):** the heading path was trimmed by position instead of by level, so a page whose first heading is `##` (most scraped pages, e.g. Wikipedia) nested every later `##` section under the first one. Headings now close by level. Heading text is also cleaned: permalink anchors (`[#](url "Link to this heading")`, `¶`, `§`) dropped, links reduced to their text, markdown escapes and trailing `\` line breaks undone (Sphinx/MkDocs docs pages put an anchor in every heading, which went into citations and embeddings). **Website/text sources ingested before this keep their old heading paths until reprocessed.**

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

- **Sweeper, reprocess, reading, cleanup (3.6):**
  - **After a deploy that adds or changes job functions, Inngest must be synced again:** `curl -X PUT https://curio-server-ten.vercel.app/api/inngest` (the SDK registers itself using the signing key), or "Resync" in the Inngest dashboard. Without it Inngest doesn't know the new functions or triggers.
  - **Sweeper** (`sweep-stuck-sources`, cron `*/5 * * * *`, no retries; values in `config.ingestion`): `PROCESSING` for more than 15 min → `FAILED` / `TIMEOUT`. `PENDING` for more than 10 min → `source/reprocess` is sent again (owner-approved; docs 02 and 03 updated), at most 100 per sweep, oldest first. Touching `updated_at` claims a source so it isn't re-sent for another 10 min. It is the only code not scoped by `userId`: it is a system job across all users. There is no cap on how long a source may wait in `PENDING`.
  - **Events:** `source/reprocess` `{ sourceId, userId }` (second trigger of `processSource`; used by the endpoint and the sweeper) and `notebook/deleted` `{ notebookId, userId, storageKeys }`.
  - **`POST /sources/:id/reprocess`** → 202 with the source in `PENDING`, error cleared. One `UPDATE … WHERE status IN ('READY','FAILED')`, so a double click gives one 202 and one 409 `ALREADY_PROCESSING`. A failed send still returns 202 (the sweeper re-sends). The old chunks stay until the new commit.
  - **`GET /sources/:id/content`** → `{ content: string | null }` (`sourceContentSchema`).
  - **`GET /sources/:id/chunks`** → `{ items, nextCursor }` in `chunk_index` order (`sourceChunkListSchema`), default 20 / max 100. The cursor is the last chunk index (base64url `{ n }`); a tampered one → 400. Embeddings and the search vector are never returned.
  - **Notebook delete:** one transaction locks the notebook, reads its sources' R2 keys, deletes it (cascade). Then `notebook/deleted` is sent with the keys; nothing is sent when there are no files. A failed send still returns 204 and logs `orphaned uploads` at warn.
  - **`cleanup-notebook-files`** deletes the keys from R2 (repeatable, so a failure retries the whole batch, `ingestion.retries` times). Keys outside `users/{userId}/uploads/` are refused and logged at error.

- **Frontend (3.7):**
  - **Failed sources** show the reason and a **Retry** button on the row; the ⋯ menu has **Retry** (failed) or **Process again** (ready). Both call `POST /sources/:id/reprocess`; the list then polls again because the source is `PENDING`.
  - **Viewer** (`source-viewer-dialog.tsx`, ⋯ → **View text and chunks**, `READY` sources only): a Text tab (`GET /content`) and a Chunks tab (`GET /chunks`, 20 per page, "Load more"). Each chunk shows its number, location (page, time range or heading path) and token count; **Show in text** switches to the Text tab with that passage highlighted and scrolled into view (`charStart`/`charEnd`).
  - Pure helpers and their tests are in `features/sources/viewer.ts` (web tests run in Node, so only logic is unit-tested).
  - **Add-source dialog:** the PDF and Text tabs now keep separate titles, so a chosen file's name no longer appears on the Text tab (owner-reported). The Website and YouTube tabs likewise keep separate URLs (owner-reported in the live Phase 3 check; checked in the browser).
  - **Checked in the browser** against the local API: failed row with Retry → Pending, the viewer's two tabs, "Show in text" highlight, and the phone layout (375 px, no sideways scroll). The dev rows used for this were restored afterwards. Not clicked: choosing a PDF file (needs a file picker).

- **Code review fixes (2026-09-30, 4 findings from the owner's review of Phase 3):**
  - **Duplicate runs:** `markProcessing` now claims only a `PENDING` source. A second run for the same source (the sweeper re-sends events for sources that wait more than 10 min) ends with `{ stopped, not_pending }` and redoes nothing. (The trade-off this first had, a retried step 1 stopping its own run, is fixed by run ownership below.)
  - **NUL characters:** Postgres can't store `\u0000` in text or jsonb. Input schemas in `packages/shared` strip it (`cleanString`: notebook and source titles, pasted text), so such input is a normal 2xx, or a 400 when nothing is left. Extraction strips it from everything it reads (text, titles, string metadata) before anything is saved.
  - **Sweeper clock:** `processing_started_at` is now set again at the start of every step (the step's first read is an `UPDATE … RETURNING`), so time across earlier steps doesn't add up. (Correction from the 2026-10-01 review: a step that waits more than 15 min in the queue *before it starts* is still timed out; see below.)
  - **`INNGEST_DEV` in production:** `loadEnv` refuses to start when `INNGEST_DEV` is on and `NODE_ENV` is production (the default). Local `.env` has `NODE_ENV=development`.


- **Retrieval v0 (4.1):**
  - `pipelines/retrieval/retrieve.ts` `retrieve({ userId, notebookId, query, limit? }, { embeddings, vectorSearch })` → `RetrievedChunk[]` (rank from 1, source id/title/type, chunk index, content, context header, `location` {page, start/end seconds, heading path, char range}, `score` = cosine similarity). No HTTP and no DB import; the eval runner (4.3) and chat (Phase 5) inject the providers. A blank query returns `[]` without an embeddings call; a bad `limit` throws `RangeError`.
  - `repositories/retrieval.repository.ts` `vectorSearch`: nearest by cosine distance (`<=>`, the HNSW index's operator), filtered by `notebook_id` + `sources.user_id` + `sources.status = 'READY'` (a failed reprocess keeps its old chunks). Another user's notebook → empty list; turning that into a 404 is the calling service's job.
  - **Iterative scan:** each search runs in a transaction that sets `hnsw.iterative_scan` locally (`set_config(…, true)`, so it never leaks to other queries on a pooled connection). Mode `strict_order` (results exactly ordered by distance) is in `config.retrieval.hnswIterativeScan`. pgvector on Neon is 0.8.6.
  - **Proof it matters:** an integration test forces the planner onto the HNSW index (100 chunks next to the query in another notebook, 5 far ones in the target). With the scan off, the target comes back short; with `strict_order`, all 5 come back in order.
  - **Sizes:** `config.retrieval.vectorCandidates` = 40 (the candidate pool fusion and rerank will start from). The eval metrics' cut-offs (k = 5, 10) are applied by the runner.
  - Not done: the query embedding and the stored chunk embeddings aren't checked for the same model (`sources.embedding_model`). Only one model exists today; worth a guard if the model ever changes.

- **Golden dataset (4.2):**
  - **`evals/` is a workspace package** (`@curio/evals`; `pnpm-workspace.yaml` lists it). It imports the server's providers, extractor and chunker by relative path, so what it chunks is exactly what ingestion stores. No new third-party dependency (`zod`, `tsx`, `typescript`, `vitest`, `@types/node` are already used in the repo). Scripts: `fetch-docs` (named so because `pnpm fetch` is a built-in pnpm command), `check`, `review`, `preview`, `test`, `typecheck`. See `evals/README.md`.
  - **Documents (owner-chosen theme: ML fundamentals):** "Attention Is All You Need" (arXiv PDF, 15 pages, 28 chunks), the Dropout paper (JMLR PDF, 30 pages, 55 chunks), Wikipedia "Overfitting" (49 chunks), scikit-learn "1.1. Linear Models" (76 chunks), 3Blue1Brown "But what is a neural network?" (9 chunks), StatQuest "Ridge (L2) Regression" (7 chunks), and original notes on gradient descent written for the dataset (`evals/dataset/notes/gradient-descent.md`, 14 chunks). 238 chunks in total. Five documents touch regularization, so retrieval is realistically hard.
  - **Third-party content is never committed** (owner's choice): it is fetched with the app's own Firecrawl/Supadata providers (and plain downloads for PDFs) into gitignored `evals/.cache/`. `documents.json` stores each URL plus the SHA-256 of what was fetched; `fetch-docs` fails if cached content no longer matches.
  - **Questions:** 70 in `questions.jsonl`: 33 factual, 15 exact-term, 6 multi-part (most span two documents), 6 follow-up (with `history`), 10 unanswerable (near the topic, e.g. BERT warmup, ILSVRC-2014, WMT 2016). Every document has 7–13 questions. Drafted by the agent from the chunk previews (no LLM API call).
  - **Expected locations** (`evals/src/relevance.ts`, unit-tested): PDF = page; YouTube = a time window around where the fact is said, and a chunk counts if its time range overlaps it (the video chunks span ~2–3 minutes); website/text = the chunk's exact heading path (`null` = before the first heading). An exact path, not a prefix, because every scikit-learn chunk sits under "1.1. Linear Models".
  - **`check`** validates both files and confirms every expected location matches at least one chunk ingestion produces; it passes. **`review`** writes `.cache/review.md` for the owner.
  - **Found in passing:** ~20 of Wikipedia's 49 chunks are the page's navigation boxes (link tables under "External links"), and scraped markdown keeps every link URL. Realistic noise for the baseline; stripping link URLs or navboxes is a Phase 6 candidate (chunk quality).

- **Eval runner (4.3):**
  - `pnpm eval` (root) → `evals/scripts/run-eval.ts`. Runs on Neon **`dev`** (`DATABASE_URL`); refuses when that is the production or test database. Each run deletes the eval user's (`eval_runner`) notebook and ingests the dataset fresh, so runs are independent.
  - **Ingests through the real `IngestionService`** (`start` → `extract` → `chunk` → `embedAndCommit`, as the job would) with R2, Firecrawl and Supadata replaced by cache-backed providers (`evals/src/cached-providers.ts`); embeddings are real OpenAI calls. Queries go through the real `retrieve()` with the retrieval repository.
  - **Metrics** (`evals/src/metrics.ts`, unit-tested): hit rate@5/@10 and MRR over the answerable questions (MRR cut off at the top 10, which is all that is retrieved), overall and per category. Unanswerable questions don't count (they are for refusal accuracy in Phase 5), but their top score is recorded for tuning the relevance gate.
  - **Results file** (`evals/results/<date>-<config>.json`, test plan §6.6): date, git commit + dirty flag, config label (`vector` + each flag that is on) and flags, embedding model, chunking settings, dataset size, metrics, per-category metrics, cost (tokens counted with the app tokenizer × `evalConfig.embeddingUsdPerMillionTokens`), duration, and every question's top 10 with location, score and relevance.
  - **Eval-only settings** (k values, eval user, price) are in `evals/src/config.ts`; app limits/models/flags are read from `apps/server/src/config/`, so the eval measures the real pipeline.
  - **Reproducible:** two back-to-back runs gave identical metrics and identical first-relevant ranks for every question. Deeper in the top 10, 8 questions swapped neighbouring chunks because OpenAI embeddings vary slightly between calls (similarity differs by ≤ 0.004).
  - `evals` depends on `drizzle-orm` (already used by the server) for the eval notebook's rows.
  - **Dataset fix:** q-006 (big Transformer training time) also has its answer on page 8, so page 8 was added as an expected location (the first run marked that correct chunk as a miss).

- **Code review fixes (2026-10-01, 2 findings from the owner's review of 4.1–4.4 and the earlier fixes):**
  - **Run ownership (fixed):** `sources.processing_run_id` (migration `0007`; `03-database-design.md` updated) holds the Inngest run that owns a `PROCESSING` source. The claim succeeds for a `PENDING` source, or for one already `PROCESSING` under the same run ID, so a retried step 1 (its first attempt committed but Inngest never recorded it) keeps its claim instead of stopping its own run. Every job write (`findForExtraction`, `saveExtraction`, `findExtracted`, `commitChunks`, `markFailed`) now requires the run ID too, so a duplicate run or a superseded older run can never write, and `onFailure` only fails the source if its own run still owns it (it gets `event.data.run_id`). The Inngest handler takes `runId` from its context (stable across a run's retries). `SourceRef` stays for IDs only; job code uses `RunRef` (`+ runId`).
  - **Queue wait vs the sweeper (documented, not fixed):** a step that waits in Inngest's queue for more than 15 min before it starts still gets timed out; the database can't tell that from a dead run. Needs a backlog of well over a hundred sources at current concurrency. The misleading comment in `ingestion.repository.ts` and the sentence in `03-database-design.md` are corrected; the full fix (ask Inngest whether the run is alive before failing it) is in `docs/todo-v2.md`.
  - **Test engine quirk:** `@inngest/test` gives every re-execution of the function a new random run ID and applies the engine's own `transformCtx` on the first execution, and one engine remembers earlier executions' steps. `process-source.test.ts` pins `runId`/`attempt` in the engine's `transformCtx` and builds a fresh engine per run.

- **Code review fixes (2026-10-04, 3 findings from the owner's review of Phases 5–6):**
  - **Chat lock outliving the answer:** an answer can take two model calls of up to 90s each, plus retries, but the lock lasted 120s. `Lock.extend` (Upstash: Lua, only while our token holds the key) renews it every `locks.conversationRenewSeconds` (30) while the answer is written; a crashed run still frees it ~2 min later. A lost lock is only logged, because of the next point.
  - **Answers saved in the wrong place:** `saveAssistantMessage` now takes `questionSeq` and saves at `questionSeq + 1`. A retry deletes the `ERROR` answer only if it is still in that slot and takes its `seq`, so resending an earlier failed question gives Q1 A1 Q2 A2, not Q1 Q2 A2 A1. A new answer needs its question to be the last message. Slot taken → nothing saved (not even `ERROR`) and the stream ends with `INVALID_STATE`, so a run that lost its lock can't add a second answer or answer the wrong question.
  - **Dropped connection (web):** `use-answer-stream` keeps the turn on screen ("The connection was lost. Waiting for the answer to be saved…") and polls the newest messages every 3s for up to 150s, until `isAnswerSaved` (the streamed answer's ID, or an answer right after the question). A last question with no answer (`display.ts`) shows "This question has no answer yet." with Retry; the retry endpoint already answers that case (now in the API doc).
  - Tests: 4 chat integration tests (lock held through 4 min, a stale run not saved over the fresh one, nor after a later question, the earlier-question resend order) and 5 web tests. API doc §5 and the locks table updated.

## Eval results so far
**Retrieval baseline, vector only** (`evals/results/2026-09-30-vector.json`, commit `dc908a9`, `text-embedding-3-small`, chunks 500 tokens / 15% overlap, 7 documents, 238 chunks, 60 answerable questions; top 10 retrieved; cost $0.002):

| | Questions | Hit rate@5 | Hit rate@10 | MRR |
|---|---|---|---|---|
| **Overall** | 60 | **0.933** | **0.967** | **0.796** |
| factual | 33 | 0.970 | 1.000 | 0.855 |
| exact-term | 15 | 0.933 | 1.000 | 0.867 |
| multi-part | 6 | 1.000 | 1.000 | 0.547 |
| follow-up | 6 | 0.667 | 0.667 | 0.542 |

What it says for Phase 6:
- **Follow-ups are the weak spot**, as expected: "Is it deterministic?" and "What values of c are typical?" find nothing without the conversation. Query rewrite targets exactly this.
- **Multi-part** questions always find *one* of their locations but rank the right chunks lower (MRR 0.55). Hit rate only needs one relevant chunk, so it can't show whether sub-queries find *every* part; a per-question "all locations found" measure would, worth adding with sub-queries.
- **A score threshold alone can't refuse:** top similarity for unanswerable questions reaches 0.68 while some answerable ones sit at 0.24. The relevance gate will need rerank scores, not raw cosine.
- The numbers are high overall: questions tend to reuse the documents' wording. The ablation still has room at MRR and on follow-ups; a few harder paraphrased questions would make later gains clearer.

**Answer baseline, vector only** (`evals/results/2026-10-01-vector.json`, commit `d0ff7d3`, generator `gpt-6-luna`, judge `gpt-6.1-sol`, top 8 chunks to the model, 2 runs averaged; retrieval numbers identical to the table above; cost $0.58, 8 min):

| | Faithfulness | Correctness (1–5) | ≥ 4 | Citation accuracy | Refusal accuracy | False refusals |
|---|---|---|---|---|---|---|
| **Overall** | **0.980** | **4.38** | **0.83** | **0.821** | **0.95** | **0** |
| factual | 0.986 | 4.71 | 0.97 | 0.917 | | 0 |
| exact-term | 1.000 | 4.73 | 0.93 | 1.000 | | 0 |
| multi-part | 0.937 | 2.50 | 0.08 | 0.583 | | 0 |
| follow-up | 1.000 | 3.50 | 0.58 | 0.472 | | 0 |

| unanswerable | 1.000 | | | | 0.95 | |

What it says:
- **Grounding is already strong:** almost every claim is supported by what it cites, and no answerable question was refused. The gains left are in *finding* the right chunks, which is Phase 6's job.
- **Multi-part answers cover one part** (correctness 2.5, only 1 in 12 scores ≥ 4): retrieval brings back one side of "compare X and Y". Sub-queries target this.
- **Follow-ups** (3.5, citation accuracy 0.47): the search uses the raw follow-up ("Is it deterministic?"). Query rewrite targets this.
- **The one missed refusal is a partial one** (q-066, BERT warmup steps, 1 of the 2 runs): "the sources don't say … but the Transformer used 4,000 warmup steps [1]". Refusals are detected by the exact reply, so a hedge with a citation counts as an answer. The relevance gate (6.5) should stop these before the model sees unrelated chunks.
- **Citation accuracy is strict:** a citation to a correct passage that isn't one of the question's expected locations counts as wrong, so the number is a lower bound.
- **Run-to-run noise:** the two runs differ by ~0.08 in correctness and ~0.01 in faithfulness, and a run before the final one gave 4.29 / 0.971. Treat answer-metric changes under ~0.1 correctness / ~0.02 faithfulness as noise in the ablation.
- **Cost:** Sol (judging) is 95% of the $0.58; Luna's prompt caching worked (52% of its input tokens cached). The judge prompts are too short for OpenAI's cache.

**Ablation, Luna judge** (decision O-04; every config re-run so all three share a judge; generator Luna, top 8 chunks, 2 runs averaged; ~$0.07 and 7–12 min per run). The Sol-judged numbers above are kept for history only; don't compare them with these.

| Config | Hit@5 | Hit@10 | MRR | Faithful. | Correct. | ≥ 4 | Citation acc. | Refusal acc. | False ref. |
|---|---|---|---|---|---|---|---|---|---|
| vector (`68e42f1`) | 0.933 | 0.967 | 0.796 | 0.976 | 4.50 | 0.84 | 0.832 | 0.90 | 0.008 |
| + rewrite (`68e42f1`) | 0.950 | **1.000** | 0.814 | 0.956 | 4.59 | 0.88 | 0.867 | 0.95 | 0 |
| + hybrid (`26054a9`) | **0.967** | 0.983 | **0.845** | 0.963 | **4.73** | **0.97** | 0.865 | 0.95 | 0 |
| + rerank pro (`7df8e28`) | 1.000 | 1.000 | 0.983 | 0.985 | 4.83 | 0.97 | 0.866 | 0.85 | 0 |
| + rerank **fast** (`7df8e28`) | **1.000** | **1.000** | **0.983** | 0.968 | 4.78 | 0.95 | 0.847 | 0.95 | 0 |
| + gate 0.70 (`0568397`) | 1.000 | 1.000 | 0.983 | **0.990** | 4.74 | 0.96 | 0.842 | **1.00** | **0** |

| By category (correctness · MRR) | vector | + rewrite | + hybrid |
|---|---|---|---|
| factual | 4.79 · 0.855 | 4.76 · 0.855 | 4.82 · 0.850 |
| exact-term | 4.93 · 0.867 | 4.83 · 0.867 | 4.87 · 0.856 |
| multi-part | 2.83 · 0.547 | 3.00 · 0.547 | **3.75 · 0.806** |
| follow-up | 3.50 · 0.542 | 4.67 · 0.728 | **4.92 · 0.833** |

- **Rewrite (6.2) kept:** follow-ups 3.50 → 4.67, MRR 0.54 → 0.73. Same picture as the Sol-judged run.
- **Hybrid (6.3) kept:** correctness ≥ 4 goes 0.88 → 0.97; multi-part gains most (MRR 0.55 → 0.81, ≥ 4 from 1 in 12 to 8 in 12): keyword matches pull in the second side of a comparison. Exact-term is flat: one question (q-002, "d_model") drops out of the top 10 because Postgres splits `d_model` into "d" + "model", and chunks found by both lists outrank its vector-only hit under RRF. Not tuned for one question; rerank (6.4) sees the 40 fused candidates, where it still is.
- **Rerank (6.4):** retrieval near-perfect (MRR 0.85 → 0.98, every answerable question's location in the top 5). Answers barely move (they were already 4.7+), so its value is retrieval headroom and the 0–1 scores the gate needs. Fast = pro on retrieval, answers within noise, faster and cheaper → fast. Rerank latency p50 745 ms / p95 1.2 s (fast, Trial key). Rerank cost ≈ $0.14 per run (70 searches), now the biggest line of a run.
- **Gate (6.5):** all 10 unanswerable questions refused before the model (top rerank scores 0.19–0.67), no answerable one refused (lowest 0.725). Answers unchanged within noise; faithfulness 0.97 → 0.99. The 0.70 threshold sits in a narrow gap found on the same questions: watch for false refusals live.
- **Luna as judge** scores a little higher than Sol (vector correctness 4.50 vs 4.38) and is ~9× cheaper per run. One Luna judge reply degenerated into escape codes and broke a run; that error is now retried.

## Session log
<!-- Newest first. One entry per session:
### YYYY-MM-DD
- Done: steps X.Y–X.Z
- Commits: <short hashes>
- Notes: anything the next session must know
-->

### 2026-10-04 (Phase 9 doc changes)
- Done: 9.0, the doc changes for "Curio teaches" (owner approved, with the recommended picks: uncovered concepts taught as marked general knowledge; the tutor suggests mark done, the learner clicks)
- Notes: the decisions table pointed "Lessons: Luna or Sol?" at A-10, which is the R2 SDK decision; it's L-12 now

### 2026-10-04 (code review fixes)
- Done: 3 findings from the owner's review of Phases 5–6 (chat lock renewal, answer placement, dropped connection in the web app); see "Code review fixes (2026-10-04)"
- Notes: full suite green (server 765, web 91, evals 29). A first run failed widely because another vitest run was using the test database at the same time; rerun alone it passed

### 2026-10-03 (Phase 7 approved, 8.1)
- Done: 8.1 learning tables migration (`0010`, dev + test); 8.2 Tavily provider + prefill endpoint; 8.3 `generateLearningPath` part 1; 8.4 part 2 (map → outline → READY); 8.5 learning path API; 8.6 frontend
- Owner: added `TAVILY_API_KEY` on Vercel and ran `0010` on prod
- Notes: checkpoint before push: full suite 821 tests pass (716 server, 81 web, 24 evals); lint, typecheck, `typecheck:vercel` clean. Pushed `85e67dd`; deploy READY; Inngest resynced
- Notes (8.4): checkpoint before push: full suite 847 tests pass (742 server, 81 web, 24 evals); the learning-path job file passed 5 runs in a row; lint, typecheck, `typecheck:vercel` clean. Pushed `555059b`; deploy READY, `/health` ok; Inngest resynced (`modified: true`)
- Notes (8.5): checkpoint before push: full suite 866 tests pass (761 server, 81 web, 24 evals); lint, typecheck, `typecheck:vercel` clean. Pushed `f58a49d`; deploy READY, `/health` ok
- Notes (8.6): full suite 871 tests pass (761 server, 86 web, 24 evals); `next build` ok
- Owner: "start with phase 8" (Phase 7 approved)

### 2026-10-03 (faster tests)
- Done: tests moved to a local Docker Postgres (PR-06); unit and integration split into Vitest projects
- Notes: server suite 582 tests in ~25 s (281 unit in ~1.5 s, 301 integration in ~23 s), was ~25 min on Neon `test`. This run covered 7.1, so the full-suite gap since 6.4 is closed

### 2026-10-03 (7.6, Phase 7 built)
- Done: 7.6 memory API + page + "Noted" notice; Inngest resynced for the Phase 7 jobs (owner's screenshot showed them missing)
- Notes: full suite 751 tests pass (646 server, 81 web, 24 evals); web build ok

### 2026-10-03 (7.5)
- Done: 7.5 learner profile in the chat prompts
- Notes: full suite 738 tests pass (637 server, 77 web, 24 evals)

### 2026-10-03 (7.4)
- Done: 7.4 memory extraction job; owner ran `0009_memories` on prod
- Notes: full suite 731 tests pass (630 server, 77 web, 24 evals); decision M-06 added

### 2026-10-03 (7.3)
- Done: 7.3 `memories` migration + repository
- Notes: full suite 710 tests pass (609 server, 77 web, 24 evals); `0009` applied on dev (test migrates itself), prod pending

### 2026-10-03 (7.2)
- Done: 7.2 topics + `PATCH /notebooks` `topic`
- Notes: first step on the local Docker test DB (PR-06); full suite 697 tests pass (596 server, 77 web, 24 evals)

### 2026-10-02 (Phase 6 approved, 7.1)
- Done: 7.1 conversation summary job
- Owner: "Start Phase 7" (Phase 6 approved); stopped the checkpoint run and the targeted test runs; asked to finish 7.1 and push. Pushed with lint + typecheck + `typecheck:vercel` clean and the 15 new 7.1 tests passing (run before the last two small fixes); `chat.test.ts` and the full suite **not** run
- Notes: 6.5–6.8 were already on `main` and deployed (`4e62219`); this push added 7.1 only. Both Vercel deploys of `ddb3345` READY, `/health` ok

### 2026-10-02 (6.5–6.8, Phase 6 built)
- Done: 6.5 relevance gate (on, 0.70), 6.6 citation check, 6.7 HyDE / chunk size (not adopted, R-09; owner stopped the trial runs), 6.8 timeouts + degradation
- Notes: new test policy in use (targeted tests per step, full suite at the checkpoint before this push)

### 2026-10-02 (6.4)
- Done: 6.4 Cohere rerank + eval; `rerank-v4.0-fast` picked; flag off until a Production key is on Vercel
- Owner: skip Jina (build plan + R-04 updated); stray branch `main-nsmje6` deleted from GitHub; rerank turned on with the Trial key already on Vercel; **new test policy** (CLAUDE.md): targeted tests per step, full suite only at checkpoints before a push. Checkpoint run: 648 tests pass (547 server, 77 web, 24 evals)
- Notes: the local Cohere key is a Trial key (10 calls/min): first runs lost 12/70 reranks to 429 and were discarded; the eval now paces rerank calls. Owner moved `DATABASE_URL`, `CLERK_SECRET_KEY`, `R2_SECRET_ACCESS_KEY` on Vercel from Config to Secret (same values; solo Hobby account, so no rotation needed) and redeployed

### 2026-10-01 (6.3, judge → Luna)
- Done: 6.3 keyword search + eval, `hybridSearch` on. Owner switched the eval judge to Luna (O-04; docs updated); vector and rewrite re-run with it
- Fixes found on the way: `createDb` now listens for pool `error` (a dropped idle Neon connection crashed the process; would also crash the server); YouTube transcripts ask Supadata for `lang=en` (an English video was ingested in **Arabic**: without `lang` Supadata returns the first caption track, which can be an auto-translation; existing sources need **Process again**); garbled structured output is a retryable `LlmError`; the eval retries ingestion steps like Inngest and checks the whole repo for uncommitted changes
- Owner asked about OpenAI usage: no leak. Oct 1 = eval runs (each Sol-judged run ~160K Sol + ~500K Luna input tokens, Luna mostly cached); Curio made no LLM calls before Oct 1, so the Sep 24 Luna spike is another app on the same OpenAI project
- A stray remote branch `main-nsmje6` (3 commits authored "Claude", turns hybrid on from the retrieval-only eval, adds `.claude/launch.json`) was pushed while the Mac slept; not ours to merge. Its two other commits are already on `main`
- Notes: test runs must not overlap (they share the `test` branch): a manual run during the full suite made 30 DB tests fail; all passed alone

### 2026-10-01 (6.2)
- Done: 6.2 query understanding + eval; `queryRewrite` turned on
- Commits: `c7953e6` (query understanding), `de00a27` (eval retry), then results + flag
- Notes: two eval attempts died on OpenAI hiccups (an embeddings response of `null`, then a Sol judge call past the 90s timeout), so the runner now retries a question on retryable errors. 1 server test failed once on a `truncateAllTables` hook timeout (Neon slow, untouched file) and passed on rerun. 212 tests rerun after the flag change: all pass

### 2026-10-01 (6.1, Phase 5 approved)
- Done: owner approved Phase 5 ("Start Phase 6"); 6.1 feature flags through the retrieval pipeline (see Resume here)
- Notes: 615 tests passing (514 server, 77 web, 24 evals); server suite took ~23 min. No eval run (6.1 has none). Owner added `COHERE_API_KEY` to local `.env` for 6.4

### 2026-10-01 (5.6, Phase 5 built)
- Done: 5.6 answer metrics + full baseline (see "Eval results so far"); `06-test-plan.md` §6.4 now says GPT-6 models take no temperature (variance handled by fixed prompts + 2 averaged runs)
- Commits: `d8dbb02` (answer metrics), `d0ff7d3` (README format), then the baseline results from `d0ff7d3`
- Notes: 601 tests passing (500 server, 77 web, 24 evals). A first baseline run from an uncommitted tree was discarded and rerun from the clean commit so `gitCommit` is exact. First real LLM calls: smoke test ($0.007) + 2 full runs ($0.61 + $0.58)

### 2026-10-01 (5.5)
- Done: 5.5 chat frontend. New web packages: `ai`, `react-markdown`, `remark-gfm` (owner approved Markdown rendering)
- Notes: owner checked chat live: answers, citations, Langfuse traces and feedback all work. Follow-up layout fix: the notebook page now fills the window on wide screens (sources and chat scroll on their own, the message box stays in view) and the chat is one screen tall on phones; checked at 375×812, 1024×768 and 1440×900

### 2026-10-01 (5.4)
- Done: 5.4 chat API (see Resume here). New packages: `@upstash/redis`, `@upstash/ratelimit` (Upstash is in the design)
- Notes: first deploy that starts tracing and needs the Langfuse + Upstash env vars on Vercel (owner added them; names checked). 571 tests passing (498 server, 54 web, 19 evals); the server suite now takes ~23 min at ~300 ms per Neon round trip

### 2026-10-01 (5.3)
- Done: 5.3 generation pipeline (context, prompt, citations, streamed answer) + fake LLM
- Notes: pure modules, not wired into an endpoint yet (5.4). Full run: 459/462 server tests passed; the 3 failures were 20s timeouts in `notebook-cleanup.test.ts` while round trips to Neon took ~300 ms each, and the file passed 10/10 on rerun. Integration tests with many requests sit close to the 20s limit on a slow connection

### 2026-10-01 (5.2)
- Done: 5.2 LLM provider + Langfuse tracing wrapper (see Resume here)
- Notes: owner approved the new packages; Sol switched to `gpt-6.1-sol`; Langfuse + Upstash keys on Vercel. Nothing wired into the app yet. 447 tests in total (17 new). One full run failed `ingestion.test.ts` › "failure during a reprocess commit" (7.8s) and it passed on rerun: watch for flakiness

### 2026-10-01 (5.1)
- Done: 5.1 migration `0008_conversations_messages` (`conversations`, `messages`, enums `message_role` / `generation_status` / `feedback`), applied on `dev` + `test`; shared chat enums and citation snapshot schema
- Notes: `lesson_id` FK deferred to Phase 9 (see Resume here). Owner ran `0008` on production

### 2026-10-01 (Phase 4 approved)
- Owner approved Phase 4. Langfuse and Upstash keys are in `.env` (Upstash PING checked). Phase 5 is ready to start
- Notes: Neon is in AWS us-west-2 (Oregon); the Vercel function region wasn't confirmed (Vercel's default is Washington D.C.). Check and align it in Phase 6's latency work

### 2026-10-01 (review fixes 4)
- Done: run ownership for job runs (`processing_run_id`, migration `0007` on `dev` + `test`); queue-wait limit of the sweeper documented, full fix in `todo-v2.md`
- Notes: 494 tests passing (421 server, 54 web, 19 evals). Pushed after the owner ran `0007` on production

### 2026-10-01 (4.4, Phase 4 built)
- Done: 4.4 (baseline committed: hit rate@5 0.933, @10 0.967, MRR 0.796). Phase 4 waits for the owner's approval

### 2026-10-01 (4.3)
- Done: 4.3 (`pnpm eval`: real ingestion + retrieval on `dev`, hit rate@k + MRR, results JSON). Owner approved the dataset after a spot check
- Notes: 491 tests passing (418 server, 54 web, 19 evals). Two trial runs cost ~$0.002 each

### 2026-09-30 (4.2, 🛑 dataset review)
- Done: 4.2 (`@curio/evals` package, 7 documents fetched into the local cache, 70 questions, relevance rule, `check`/`review`/`preview` scripts)
- Notes: 485 tests passing (418 server, 54 web, 13 evals). Stopped for the owner's dataset review

### 2026-09-30 (chunker heading fix)
- Done: heading paths close by level (a page starting at `##` no longer nests all sections under the first) and heading text is cleaned of permalink anchors, links, escapes. Found while reading the 4.2 dataset's chunks
- Notes: 472 tests passing (418 server, 54 web). The Neon `test` branch was slow this session (the server suite took ~16 min instead of ~10)

### 2026-09-30 (4.1)
- Done: 4.1 (retrieval v0: vector-only search, notebook + READY filter, iterative scan)
- Notes: 468 tests passing (414 server, 54 web). Owner chose the 4.2 dataset: theme **ML fundamentals** (2 PDFs incl. "Attention Is All You Need", Wikipedia "Overfitting", scikit-learn "Linear Models", 3Blue1Brown neural networks video, StatQuest ridge regression video, original study notes on gradient descent); third-party content kept in a **gitignored local cache**, with URL + SHA-256 in `documents.json`

### 2026-09-30 (Phase 3 approved)
- Owner approved Phase 3 and the source error-code list. Added `docs/todo-v2.md` for deferred work (first entry: block YouTube links on the Website tab)

### 2026-09-30 (live Phase 3 check)
- Done: fixed the owner-reported shared URL between the Website and YouTube tabs of the add dialog
- Notes: web typecheck, lint and 54 web tests pass; checked in the browser against the local API. Phase 3 still awaits approval

### 2026-09-30 (review fixes 3)
- Done: 4 owner-reported fixes from the Phase 3 code review (duplicate runs, NUL characters, sweeper clock, `INNGEST_DEV` in production)
- Notes: 449 tests passing (395 server, 54 web)

### 2026-09-30 (3.7, Phase 3 built)
- Done: 3.7 (Retry / Process again, text and chunk viewer, separate titles in the add dialog, failure codes listed in the API doc)
- Notes: 439 tests passing (385 server, 54 web). Phase 3 is waiting for the owner's live checks and approval

### 2026-09-30 (3.6)
- Done: 3.6 (sweeper, reprocess, content + chunks endpoints, notebook cleanup job). Owner synced the Inngest app and saw a text source go Pending → Processing → Ready on the live app
- Notes: 419 tests passing (385 server, 34 web)

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
