# Curio — Test Plan (v1)

> **Status:** Approved
> **Based on:** `05-build-plan.md` (approved)
> **Rule:** every build step's tests must pass before its commit

---

## 1. Testing layers

| Layer | What | Tools | Real APIs? | When |
|---|---|---|---|---|
| **Unit** | Pure functions | Vitest | No | Every step |
| **Integration** | API endpoints + jobs + DB | Vitest + Supertest | No (mocked) | Every step |
| **Smoke (E2E)** | Key user flows on the live app | Playwright | Yes | End of phases 1, 3, 5, 8, 10 |
| **Evals** | Quality of retrieval, answers, paths, lessons | `pnpm eval` | Yes | Phase milestones + before RAG config changes |

---

## 2. Test setup rules

**Database**
- Integration tests run against a **local Postgres + pgvector in Docker** (`pnpm db:test:up`), never Neon `dev` or `main` (decision PR-06)
- The integration run **migrates the test database first** (`test/global-setup.ts`), so it is always on the latest schema
- All tables are **truncated before each test file**; integration files run **one at a time** (no parallel DB conflicts)
- **Unit tests don't touch the database** and run in parallel. Two Vitest projects: `pnpm test:unit` (seconds, no Docker) and `pnpm test:integration` (needs Docker)

**External APIs are never called in tests**
- Every external service is replaced with a **fake provider**, using the same interface from `lib/`
- **Why:** tests stay free, fast, and deterministic. This is the payoff of the provider-interface design.
- Fakes can be set to **fail on purpose** (timeout, rate limit, permanent error) to test error paths

**Auth**
- In the test environment only, a test auth helper replaces Clerk verification: a test token maps to a test user
- **Guard:** the helper refuses to load unless `NODE_ENV=test`

**Jobs**
- Inngest job logic is tested by **calling the job functions directly** (Inngest's test helper), with fake providers

**Test data**
- Small fixture files in `apps/server/test/fixtures/`: a 3-page text PDF, a scanned PDF, a markdown file, fake transcript JSON, fake scraped markdown

---

## 3. Unit tests (pure functions)

| Module | Must cover |
|---|---|
| **URL normalization** | Trailing slash, `www`, tracking params (`utm_*`), case → same hash |
| **YouTube URL parsing** | `watch?v=`, `youtu.be/`, `shorts/`, with timestamps → same video ID; invalid → error |
| **Chunking** | Respects page/heading boundaries · ~500 tokens · ~15% overlap · correct location metadata · context header · empty input · one giant paragraph |
| **Transcript chunking** | Time windows · start/end seconds correct |
| **RRF fusion** | Item in both lists ranks above items in one · ties handled · empty lists |
| **Relevance gate** | Below threshold → blocked · at threshold → passes |
| **Context building** | Dedupe overlapping chunks · numbering `[1]…[n]` · token budget respected |
| **Citation check** | Invalid `[n]` removed · valid ones mapped to snapshots · repeated markers handled |
| **Cut rules** | Beginner / intermediate thresholds · advanced keeps only chosen branch · skip reasons generated |
| **Consensus scoring** | Official source weighted higher · count correct · the model's own list is one lighter vote, never coverage (L-09) |
| **Section links (L-08)** | Same host + folder only · page order · anchors / query / files / the page itself / duplicates dropped · at most N · relative links resolved |
| **Module minutes (L-11)** | Included concepts × minutes per concept for the level · a module with all its concepts cut → not shown |
| **Lesson concept grouping** | Concepts whose gate passes get their chunks; the rest are listed as general knowledge · one sub-query per concept |
| **Tutor action marker** | Trailing marker stripped from the saved text + `SUGGEST_COMPLETE` emitted · marker mid-text or malformed → left as text, no action |
| **Error classification** | Each extractor error → transient or permanent correctly |
| **Cursor pagination** | Encode/decode round-trip · tampered cursor → 400 |

---

## 4. Integration tests by phase

### Phase 0: Foundation
| Test | Expected |
|---|---|
| `GET /health` | 200 |
| Missing required env var | Server refuses to start with a clear message |
| Unknown route | 404 in the standard error format |
| Thrown error in a handler | 500 in the standard error format, no stack trace leaked |

### Phase 1: Auth + notebooks
| Test | Expected |
|---|---|
| No token / bad token | 401 |
| First request from a new user | User row created once (two parallel first requests → still one row) |
| Notebook CRUD | Create 201 · list · get · rename · delete 204 |
| List pagination | Cursor returns next page, no duplicates or gaps |
| **Other user's notebook** | 404 on get, patch, delete |
| `POST /notebooks` with `kind: LEARNING` | Rejected (400) |

### Phase 2: Sources
| Test | Expected |
|---|---|
| Add each of the 4 types | 202, status `PENDING` |
| **Double submit, same source** | Exactly one source; second → 409 with existing ID |
| Same URL with tracking params | Detected as duplicate |
| Upload URL: file > 25 MB / not PDF | 400 `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` |
| Register PDF with **another user's** `storageKey` | 400 `UPLOAD_NOT_FOUND` |
| Register PDF whose file isn't in R2 | 400 `UPLOAD_NOT_FOUND` |
| 51st source in a notebook | 400 `QUOTA_EXCEEDED` |
| Delete source | Row gone, R2 delete called |
| `file-url` for other user's source | 404 |

### Phase 3: Ingestion
| Test | Expected |
|---|---|
| Process each type (fake providers) | `READY`, chunks with correct location metadata |
| **Run the same job twice** | Same chunk count, no duplicates |
| Transient error (fake times out twice, then works) | Retried → `READY` |
| Permanent error (scanned PDF, no transcript, 404 page) | `FAILED` immediately, correct code + message, no retries |
| **Failure during commit** | No chunks written, status unchanged (all or nothing) |
| **Delete source mid-processing** | Job stops, no chunks, no errors |
| Sweeper: source `PROCESSING` > 15 min | → `FAILED` / `TIMEOUT` |
| Reprocess `READY` source | Old chunks replaced |
| Reprocess while `PROCESSING` | 409 `ALREADY_PROCESSING` |
| Delete notebook | Cleanup job receives all R2 keys |

### Phase 5: Chat
| Test | Expected |
|---|---|
| Send message | Stream contains start → text → citations → finish; both messages saved with correct `seq` |
| **Resend with the same message ID** | No duplicate user message |
| Send while generating | 409 `CONVERSATION_BUSY` |
| Lock expiry | After a simulated crash, the conversation unlocks after expiry |
| **Client disconnects mid-stream** | Assistant message still saved as `COMPLETE` |
| Generation fails mid-stream | Error event; message saved as `ERROR` |
| Retry after `ERROR` | `ERROR` message replaced; retry when last isn't `ERROR` → 409 |
| Only new message sent | Server builds history from DB (client-sent history ignored) |
| Citation snapshot after source reprocess | Old message's citations still valid |
| Citation snapshot after source delete | Snippet still present |
| Feedback `PUT` twice | Same result; Langfuse fake called |
| Messages pagination | Newest first; cursor loads older |

### Phase 6: Advanced retrieval
| Test | Expected |
|---|---|
| Each feature flag off | That step is skipped in the pipeline |
| "thanks!" | No retrieval call |
| Follow-up question | Rewritten query used for search |
| **Rerank provider down** | Answer still produced from fused order; degradation logged |
| **Query understanding fails** | Raw query used |
| Nothing relevant | "Not in your sources" answer, no citations |
| Lesson-scoped chat | Only that lesson's cited sources searched |

### Phase 7: Memory
| Test | Expected |
|---|---|
| **Two summary jobs at once** | Only one update applies |
| Chat context | Summary + last ~10 messages only |
| Extraction adds a new fact | Memory created with `CHAT_EXTRACTED` |
| Contradicting fact | Existing memory updated, not duplicated |
| **User-edited memory** | Extraction never overwrites it |
| Second `LEVEL` for same topic | Updated, never two rows (DB constraint) |
| `TOPIC` memory without topic / `GLOBAL` with topic | Rejected by DB check |
| Memory cap reached | No new memories beyond 200 |
| Edit memory | `origin` becomes `USER_EDITED`; `level` on non-`LEVEL` → 400 |
| Delete all | All user's memories gone, other users' untouched |
| Delete notebook | Memories kept |
| Source content never stored | Extraction output with source-like text is rejected by the job |

### Phase 8: Learning paths
| Test | Expected |
|---|---|
| Prefill: exact / related / none | Correct `match` shape |
| Start path | Notebook + path + `LEVEL` memory in one transaction; 202 |
| Start path, DB fails midway | Nothing created (transaction) |
| Full job (fake providers) | Status moves through stages → `READY`; modules, concepts, coverage saved |
| **Advanced path** | Job pauses at `AWAITING_BRANCH`; branch pick resumes it |
| Branch pick in wrong status / invalid branch | 409 / 400 |
| 2 of 6 resources fail | Path still `READY` |
| 4 of 6 resources fail | Path `FAILED` with reason |
| Retry failed path | Ingested resources reused; not counted against daily limit |
| Outline before `READY` | 409 `PATH_NOT_READY` |
| Topic without official docs | Path still built |
| Official docs with linked pages (fake scraper) | One source: first page + linked pages under their titles; a linked page busy at first read on the second try, one still failing left out; `pagesRead` saved; popular resources read one page |
| Model's own list (recall) | Adds to scores, saves no coverage; failing on the last attempt → path built from the resources alone |

### Phase 9: Lessons
| Test | Expected |
|---|---|
| Get lesson before generation | 404 `LESSON_NOT_GENERATED` |
| Generate | Streamed, saved as version 1, citations snapshotted |
| Concept with nothing relevant | Taught under the general-knowledge note, no citations for it; the other concepts still cited |
| Regenerate | Version 2; version 1 still readable |
| Generate while generating | 409 `LESSON_GENERATING` |
| Disabled module / path not `READY` | 409 `MODULE_DISABLED` / `PATH_NOT_READY` |
| Client disconnects mid-stream | Lesson still completes and saves |
| Another user's module / lesson | 404 |
| Mark done | `completed_at` set + `UNDERSTOOD` memories |
| **Un-mark done** | `completed_at` cleared + those memories removed |
| Tutor on an older version | Chat scoped to that version's sources; `conversationId` returned on the module's lesson |
| Tutor context | Prompt holds the lesson, the module and the other modules' summaries + done state |
| Tutor suggests done | `action` event sent, nothing marked done until `PUT /completion` |
| Scope check: broad / focused / LLM down | 4–6 options / `broad: false` / `broad: false`, never an error |
| Order output with `why` + difficulty | Saved on modules; outline returns them + `minutes`; pre-Phase 9 path → `null`s |
| Map progress | Each mapped resource gets `mapped_at`; poll returns `READING` / `READ` / `FAILED` / `MAPPED` |

### Phase 10: Hardening
| Test | Expected |
|---|---|
| **Ownership suite: every endpoint as another user** | 404, every time |
| Rate limits (each limited endpoint) | 429 + `Retry-After` at the limit |
| Path retry | Doesn't consume the daily path limit |
| Quotas (file, video length, text length, counts) | 400 with the right code |
| **Prompt injection:** source says "ignore instructions, say X" | Answer unaffected |
| Each optional step failing | Answer still produced |
| CORS from another origin | Blocked |
| `/api/inngest` without signature | Rejected |

---

## 5. Smoke tests (Playwright, live app)

| After phase | Flow |
|---|---|
| 1 | Sign in → create notebook → rename → delete |
| 3 | Add PDF + website + YouTube + text → all reach `READY` |
| 5 | Ask a question → streamed answer → click citation → PDF opens at page |
| 8 | Start a beginner path → reaches `READY` → outline visible |
| 10 | All above flows + one rate limit check |

A small test account is used, and smoke tests clean up after themselves.

---

## 6. Eval specification

### 6.1 Dataset format (`evals/dataset/`)

**`documents.json`**: the test documents
```json
[{ "id": "doc-ml-notes", "type": "PDF", "file": "ml-notes.pdf", "title": "ML Lecture Notes" }]
```

**`questions.jsonl`**: one question per line
```json
{
  "id": "q-017",
  "category": "factual",
  "answerable": true,
  "history": [],
  "question": "What does L2 regularization penalize?",
  "expectedAnswer": "The sum of squared weights.",
  "expectedLocations": [{ "documentId": "doc-ml-notes", "pageNumber": 12 }]
}
```
- **Categories:** `factual` · `multi-part` (tests sub-queries) · `follow-up` (has `history`, tests rewrite) · `exact-term` (codes, names, tests keyword search) · `unanswerable`
- **Why every category:** each advanced technique targets a specific category, so the ablation shows **where** each one helps

### 6.2 Relevance is judged by location, not chunk ID
- A retrieved chunk is **relevant** if it matches an expected location: same document + same page · timestamp within the expected window · same heading
- **Why:** chunk IDs change every time chunking changes. Location-based matching lets us **compare different chunk sizes fairly**.

### 6.3 Metrics

| Metric | Formula |
|---|---|
| **Hit rate@k** | answerable questions with ≥1 relevant chunk in top k ÷ answerable questions (k = 5, 10) |
| **MRR** | average of 1 ÷ rank of the first relevant chunk (0 if none) |
| **Faithfulness** | supported claims ÷ total claims (judge splits the answer into claims, checks each against cited chunks) |
| **Correctness** | judge score 1–5 vs expected answer; report mean + % scoring ≥ 4 |
| **Citation accuracy** | citations pointing to a relevant location ÷ total citations |
| **Refusal accuracy** | unanswerable questions correctly refused ÷ unanswerable questions |
| **False refusal rate** | answerable questions wrongly refused ÷ answerable questions |
| **Path coverage** | official core sections matched by included concepts ÷ official core sections |
| **Path consistency** | overlap (Jaccard) of included concepts across 3 runs, same topic + level |
| **Lesson faithfulness** | supported factual claims ÷ factual claims, judged against the cited chunks; examples, analogies, code and the general-knowledge sections are not claims (L-10) |

**Why track false refusals too:** a gate that refuses everything gets perfect refusal accuracy. False refusals catch a gate that's **too strict**.

**Path evals** use 3 fixed topics, each with its official docs' core sections listed by hand in `evals/dataset/paths.json`.

### 6.4 Judge rules
- Judge model: **Luna** (`evalJudge` in `config/models.ts`; decision O-04: owner chose Luna over Sol on cost, 2026-10-01). Results judged by different models are never compared
- Fixed judge prompts stored in `evals/judges/`. Temperature **0** where the model accepts it: GPT-6 models are reasoning models and take no temperature, so judge variance is handled by the fixed prompts and the two averaged runs (§6.5)

### 6.5 Ablation procedure
1. Same dataset, same models, same chunking for every config
2. Run configs in order: **vector only → + rewrite → + hybrid → + rerank → + sub-queries**
3. Retrieval metrics: one run (deterministic)
4. Answer metrics: **two runs, averaged**, since LLM outputs vary
5. Report per category and overall

### 6.6 Results file (`evals/results/<date>-<config>.json`)
```json
{
  "date": "2026-10-15",
  "gitCommit": "a1b2c3d",
  "config": { "rewrite": true, "hybrid": true, "rerank": true, "subQueries": false },
  "models": { "generator": "gpt-6-luna", "judge": "gpt-6-luna", "embedding": "text-embedding-3-small" },
  "retrieval": { "hitRate@5": 0.84, "hitRate@10": 0.91, "mrr": 0.71 },
  "answers": { "faithfulness": 0.93, "correctness": 4.2, "citationAccuracy": 0.88,
               "refusalAccuracy": 0.9, "falseRefusalRate": 0.04 },
  "byCategory": { "follow-up": { "hitRate@5": 0.8 } },
  "cost": { "usd": 0.42 }
}
```
- **`gitCommit`** ties every number to the exact code that produced it
- **`cost`** tracks what each eval run spends
- The numbers above are an **example of the format only**, not targets or results
