# Curio — API Design (v1)

> **Status:** Approved
> **Based on:** `02-system-design.md`, `03-database-design.md` (approved)
> **Backend:** Express + TypeScript · **Schemas:** Zod in `packages/shared`

---

## 1. Conventions

### Base & auth
- All endpoints under **`/api/v1`**
- Every request: `Authorization: Bearer <Clerk session token>` → invalid/missing → **401**
- **Exceptions:** `GET /health` (public), `/api/inngest` (Inngest-signed, no user auth)

### URL shape: shallow nesting
- **Collections nested** under their parent: `/notebooks/:notebookId/sources`
- **Single items flat:** `/sources/:sourceId`
- Ownership checked via `user_id` on every row; others' resources → **404**

### Format
- JSON, **camelCase**; timestamps ISO 8601 UTC
- **Single item** → the object; **list** → `{ "items": [...], "nextCursor": "…" | null }`
- Every body, param, and query validated with **Zod** from `packages/shared`

### Pagination
- Cursor-based: `?limit=20&cursor=<opaque>`
- **Not paginated (bounded lists):** sources per notebook (≤ 50), memories (≤ 200)

### Status codes
| Code | Meaning |
|---|---|
| 200 | Read / update OK |
| 201 | Created (ready) |
| 202 | Accepted, processing in background |
| 204 | Deleted |
| 400 | Validation / quota |
| 401 | Unauthenticated |
| 404 | Not found **or not yours** |
| 409 | Conflict / invalid state |
| 429 | Rate limited (`Retry-After` header) |
| 500 | Unexpected error |
| 503 | Essential external service down |

### Error format
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": { "url": "Must be a valid URL" }
  }
}
```
`details` only for validation errors, plus one exception: `DUPLICATE_SOURCE` carries `details.existingSourceId`.

### Async operations
- `POST` → **202** with the resource in its initial status
- Frontend polls the GET endpoint every **~2s** (TanStack Query) until a terminal status

### Safe retries
- Duplicate sources → rejected by `content_hash` → **409**
- Chat messages carry a **client-generated ID** → resends are deduped

---

## 2. Endpoint index

**39 endpoints under `/api/v1`, plus `GET /health`.**

### Notebooks (5)
| Method | Path | Success |
|---|---|---|
| GET | `/notebooks` | 200 |
| POST | `/notebooks` | 201 |
| GET | `/notebooks/:notebookId` | 200 |
| PATCH | `/notebooks/:notebookId` | 200 |
| DELETE | `/notebooks/:notebookId` | 204 |

### Sources (10)
| Method | Path | Success |
|---|---|---|
| GET | `/notebooks/:notebookId/sources` | 200 |
| POST | `/notebooks/:notebookId/uploads` | 200 |
| POST | `/notebooks/:notebookId/sources` | 202 |
| GET | `/sources/:sourceId` | 200 |
| PATCH | `/sources/:sourceId` | 200 |
| GET | `/sources/:sourceId/content` | 200 |
| GET | `/sources/:sourceId/file-url` | 200 |
| GET | `/sources/:sourceId/chunks` | 200 |
| POST | `/sources/:sourceId/reprocess` | 202 |
| DELETE | `/sources/:sourceId` | 204 |

### Chat (9)
| Method | Path | Success |
|---|---|---|
| GET | `/notebooks/:notebookId/conversations` | 200 |
| POST | `/notebooks/:notebookId/conversations` | 201 |
| GET | `/conversations/:conversationId` | 200 |
| PATCH | `/conversations/:conversationId` | 200 |
| DELETE | `/conversations/:conversationId` | 204 |
| GET | `/conversations/:conversationId/messages` | 200 |
| POST | `/conversations/:conversationId/messages` | stream |
| POST | `/conversations/:conversationId/retry` | stream |
| PUT | `/messages/:messageId/feedback` | 200 |

### Learning (11)
| Method | Path | Success |
|---|---|---|
| GET | `/learning-paths/prefill?topic=` | 200 |
| POST | `/learning-paths` | 202 |
| GET | `/learning-paths/:pathId` | 200 |
| POST | `/learning-paths/:pathId/branch` | 202 |
| POST | `/learning-paths/:pathId/retry` | 202 |
| GET | `/learning-paths/:pathId/outline` | 200 |
| PATCH | `/modules/:moduleId` | 200 |
| PUT | `/modules/:moduleId/completion` | 200 |
| GET | `/modules/:moduleId/lesson` | 200 / 404 |
| POST | `/modules/:moduleId/lessons` | stream |
| GET | `/lessons/:lessonId` | 200 |

### Memory (4)
| Method | Path | Success |
|---|---|---|
| GET | `/memories` | 200 |
| PATCH | `/memories/:memoryId` | 200 |
| DELETE | `/memories/:memoryId` | 204 |
| DELETE | `/memories` | 204 |

---

## 3. Notebooks

- **`POST /notebooks`** `{ title }` → creates **`SOURCE` notebooks only**. Learning notebooks are created only via `POST /learning-paths`.
- **`GET /notebooks/:notebookId`** → includes source/conversation counts and `learningPathId` (learning notebooks)
- **`PATCH /notebooks/:notebookId`** `{ title?, topic? }` → `topic` is found/created in `topics`
- **`DELETE /notebooks/:notebookId`** → DB cascade immediately; R2 files cleaned by a background job (`notebook/deleted`)

---

## 4. Sources

### Add a source: one endpoint, body discriminated by `type`
```json
{ "type": "WEBSITE", "url": "https://…" }
{ "type": "YOUTUBE", "url": "https://youtube.com/watch?v=…" }
{ "type": "TEXT", "title": "My notes", "content": "…" }
{ "type": "PDF", "title": "Lecture 3", "storageKey": "…", "contentHash": "…" }
```
- ← **202**, source in `PENDING` → `processSource` job starts
- **409 `DUPLICATE_SOURCE`** (existing source ID in `details.existingSourceId`) · **400 `QUOTA_EXCEEDED`**

### PDF upload flow
```
1. POST /notebooks/:id/uploads { fileName, fileSize, contentType }
   checks: ≤ 25 MB, PDF, quota
   ← { uploadUrl (signed PUT, 10 min), storageKey }

2. Browser PUTs the file directly to R2

3. POST /notebooks/:id/sources { type: "PDF", storageKey, contentHash, title }
   checks: file exists in R2, key starts with users/{userId}/
   ← 202
```
- Storage key: `users/{userId}/uploads/{uuid}.pdf`
- `contentHash`: SHA-256 computed in the browser; re-verified by the job

### Reading
- **`GET /notebooks/:id/sources`** → all sources with statuses (the endpoint the frontend polls); excludes `extracted_text`
- **`GET /sources/:id/content`** → `{ content }`: the extracted text (viewer + passage highlighting); `null` until the source has been read
- **`GET /sources/:id/file-url`** → short-lived signed GET URL (private bucket) for the PDF viewer
- **`GET /sources/:id/chunks`** → chunks in document order with their locations, cursor-paginated; never the embedding

### Reprocess
- Allowed for `FAILED` or `READY` → **202** with the source, back in `PENDING`; the old chunks stay until the new ones are committed
- `PENDING` / `PROCESSING` → **409 `ALREADY_PROCESSING`**

### Delete during processing
- The job's commit finds no source → permanent stop, no retries, nothing written

---

## 5. Chat

### Conversations
- **`POST /notebooks/:id/conversations`** `{ lessonId? }` → `lessonId` must belong to the same notebook, otherwise 404
- **`GET /conversations/:id/messages`** → **newest first**; cursor loads older messages

### Send a message: `POST /conversations/:id/messages`
```json
{ "id": "client-generated-uuid", "content": "What is regularization?" }
```
- **Only the new message is sent**; the server loads history (summary + last ~10) from the DB

**Server flow:**
```
1. Auth + rate limit (20/min, 200/day)
2. Validate
3. Busy? → 409 CONVERSATION_BUSY   (Redis lock per conversation, auto-expires ~2 min)
4. Save user message (next seq; duplicate id = retry)
5. Load summary + last ~10 messages + memories
6. Retrieval pipeline
7. Stream answer
8. Citation check → save assistant message (citations, traceId)
9. Update last_message_at
10. Thresholds passed? → conversation/summarize (> ~20 unsummarized)
                       → memory/extract (> ~6 unscanned)
```
- **Client disconnects:** generation continues and is saved

### Retry: `POST /conversations/:id/retry`
- Regenerates the answer for the last user message, **replacing** the `ERROR` message
- Last assistant message not `ERROR` → **409**

### Feedback: `PUT /messages/:id/feedback`
```json
{ "value": "UP" }
```
- `value`: `"UP"` | `"DOWN"` | `null` (null removes feedback)
- Saved on the message + sent to Langfuse as a trace score (non-blocking)

---

## 6. Learning

### Pre-fill: `GET /learning-paths/prefill?topic=…`
```json
{ "match": { "type": "RELATED", "topicName": "Machine Learning", "level": "BEGINNER" } }
```
- `type`: `EXACT` / `RELATED`; no match → `{ "match": null }`
- Read-only; not rate-limited against path creation

### Start: `POST /learning-paths`
```json
{ "topic": "Deep Learning", "level": "INTERMEDIATE", "goal": "JOB" }
```
- **One transaction:** learning notebook + path (`GATHERING`) + `LEVEL` memory (`LEVEL_CONFIRMED`)
- Then `path/requested` event
- ← **202** `{ pathId, notebookId, status }` · rate limit **5 / day**

### Progress: `GET /learning-paths/:id`
- Lightweight poll: status, hook, branch options, error

### Branch: `POST /learning-paths/:id/branch`
```json
{ "branch": "Neural network mathematics" }
```
- Status must be `AWAITING_BRANCH` → otherwise **409 `INVALID_STATE`**
- Branch must be in `branch_options` → otherwise **400**
- Saves `selected_branch` + sends the resume event → **202**

### Retry: `POST /learning-paths/:id/retry`
- Only `FAILED` → otherwise **409**
- Already-ingested resources reused; **does not count** against the daily limit

### Outline: `GET /learning-paths/:id/outline`
- Only `READY` → otherwise **409 `PATH_NOT_READY`**
```json
{
  "hook": { "what": "…", "why": "…", "example": "…", "origin": "…" },
  "modules": [
    {
      "id": "…", "position": 1, "title": "…", "summary": "…",
      "isEnabled": true, "completedAt": null, "hasLesson": false,
      "concepts": [
        { "id": "…", "name": "Supervised learning", "coveredBy": 5, "officialCovers": true }
      ]
    }
  ],
  "skipped": [ { "name": "Kernel methods", "reason": "Covered by 1 of 6 resources, advanced" } ],
  "resources": [ { "id": "…", "title": "…", "role": "OFFICIAL", "type": "DOCS", "sourceId": "…" } ],
  "progress": { "completed": 2, "enabled": 7 }
}
```

### Modules
- **`PATCH /modules/:id`** `{ isEnabled }`
- **`PUT /modules/:id/completion`** `{ completed }`
  - `true` → set `completed_at` + write `UNDERSTOOD` memories (origin `LESSON_COMPLETED`, `origin_ref` = module)
  - `false` → clear `completed_at` + remove memories with this `origin_ref`

### Lessons
```
GET /modules/:id/lesson
   ├── 200 → saved lesson (latest version)
   └── 404 LESSON_NOT_GENERATED → POST /modules/:id/lessons → stream
```
- **`POST /modules/:id/lessons`** always creates a **new version** (first generation + regenerate)
  - Checks: path `READY` · module enabled (**409 `MODULE_DISABLED`**) · not generating (**409 `LESSON_GENERATING`**, Redis lock)
  - Rate limit **50 / day**
  - Client disconnects → still completes and saves
- **`GET /lessons/:id`** → a specific version (used by "ask about this" chats linked to older versions)
- **"Ask about this"** = `POST /notebooks/:id/conversations` with `lessonId`

### Deleting a path
- Delete its notebook; there's no separate endpoint

---

## 7. Memory

### `GET /memories`
- Filters: `?scope=`, `?topicId=`, `?since=`
- Each item includes `topic { id, name }` and a server-built **`originLabel`**
- Not paginated (cap 200)

### `PATCH /memories/:id`
```json
{ "content": "Prefers short answers with one example" }
```
```json
{ "level": "INTERMEDIATE" }
```
- Only `content` / `level` editable; `level` on a non-`LEVEL` memory → **400**
- Any edit sets **`origin = USER_EDITED`** → never overwritten by extraction

### Delete
- `DELETE /memories/:id` → one
- `DELETE /memories` → all (UI confirms first)
- Deleted memories are **not re-learned from old messages**; they can be re-learned only if the user says it again later

### "Noted" notice
- After a chat answer, the frontend checks `GET /memories?since=<last seen>` a few seconds later → new `CHAT_EXTRACTED` memories show a notice

### Not included (post-launch)
- `POST /memories` (manual add)

---

## 8. Streaming protocol

Used by `POST /conversations/:id/messages`, `POST /conversations/:id/retry`, and `POST /modules/:id/lessons`. SSE via the **Vercel AI SDK** stream format.

| Event | Content |
|---|---|
| **start** | Message ID / lesson ID |
| **status** | e.g. "Searching your sources…" |
| **text** | Answer tokens |
| **citations** | Final citation snapshots (after the citation check) |
| **finish** | Trace ID |
| **error** | Error code + message (saved as `ERROR`) |

**One format → one frontend streaming component** for chat and lessons.

---

## 9. Error codes

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid body / params |
| `QUOTA_EXCEEDED` | 400 | Source / notebook / memory cap reached |
| `FILE_TOO_LARGE` | 400 | PDF over 25 MB |
| `UNSUPPORTED_FILE_TYPE` | 400 | Not a PDF |
| `UPLOAD_NOT_FOUND` | 400 | `storageKey` missing in R2 or not the user's |
| `UNAUTHORIZED` | 401 | Missing / invalid token |
| `NOT_FOUND` | 404 | Doesn't exist or not yours |
| `LESSON_NOT_GENERATED` | 404 | Module has no lesson yet |
| `DUPLICATE_SOURCE` | 409 | Same source already in notebook |
| `ALREADY_PROCESSING` | 409 | Reprocess while pending / processing |
| `CONVERSATION_BUSY` | 409 | Answer still generating |
| `LESSON_GENERATING` | 409 | Lesson still generating |
| `MODULE_DISABLED` | 409 | Lesson for a disabled module |
| `PATH_NOT_READY` | 409 | Outline / lesson before path is ready |
| `INVALID_STATE` | 409 | Action not allowed in current status |
| `RATE_LIMITED` | 429 | Rate limit hit (`Retry-After`) |
| `INTERNAL_ERROR` | 500 | Unexpected |
| `SERVICE_UNAVAILABLE` | 503 | Essential external service down |

---

## 10. Rate limits & polling map

### Rate-limited endpoints (per user)
| Endpoint | Limit |
|---|---|
| `POST /conversations/:id/messages` + `/retry` | 20 / min, 200 / day |
| `POST /modules/:id/lessons` | 50 / day |
| `POST /learning-paths` | 5 / day (retries excluded) |
| `POST /notebooks/:id/sources` | 50 / day |

### Polled endpoints
| Endpoint | Polls until |
|---|---|
| `GET /notebooks/:id/sources` | All sources `READY` / `FAILED` |
| `GET /learning-paths/:id` | `READY` / `FAILED` / `AWAITING_BRANCH` |

### Redis locks
| Lock | Released |
|---|---|
| Per conversation (generating) | On finish, or auto-expiry ~2 min |
| Per module (lesson generating) | On finish, or auto-expiry ~2 min |
