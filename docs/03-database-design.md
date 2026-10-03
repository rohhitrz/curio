# Curio — Database Design (v1)

> **Status:** Approved
> **Database:** Neon Postgres + pgvector · **ORM:** Drizzle
> **Based on:** `02-system-design.md` (approved)

---

## 1. Conventions

- **IDs:** `uuid`, default `gen_random_uuid()`. Not sequential, so not guessable in URLs.
- **Timestamps:** `timestamptz`; `created_at` on all tables, `updated_at` where rows change
- **Enums:** Postgres enums for fixed value sets
- **Ownership:** `user_id` denormalized onto user-owned tables for one-`WHERE` ownership checks
- **Deletes:** cascade from parent to child unless noted
- **JSON:** `jsonb` only for small, fixed-shape, always-read-whole data, validated by Zod before writing
- **Extension:** `CREATE EXTENSION vector;` in the first migration

---

## 2. Entity relationships

```
users 1──* notebooks 1──* sources 1──* source_chunks
  │           │  └──0..1 topics
  │           ├──* conversations 1──* messages
  │           │        └── lesson_id → lessons (optional)
  │           └──1 learning_paths
  │                    ├──* path_resources ──→ sources
  │                    ├──* concepts ──* concept_coverage ──→ path_resources
  │                    └──* modules 1──* lessons
  │
  └──* memories *──0..1 topics
                └──0..1 concepts
```

**14 tables:**
- **Core:** `users`, `notebooks`, `sources`, `source_chunks`
- **Chat:** `conversations`, `messages`
- **Learning:** `learning_paths`, `path_resources`, `concepts`, `concept_coverage`, `modules`, `lessons`
- **Memory:** `topics`, `memories`

---

## 3. Enums

| Enum | Values |
|---|---|
| `notebook_kind` | `SOURCE`, `LEARNING` |
| `source_type` | `PDF`, `WEBSITE`, `YOUTUBE`, `TEXT` |
| `source_origin` | `USER`, `LEARNING_PATH` |
| `source_status` | `PENDING`, `PROCESSING`, `READY`, `FAILED` |
| `message_role` | `USER`, `ASSISTANT` |
| `generation_status` | `COMPLETE`, `ERROR` (messages + lessons) |
| `feedback` | `UP`, `DOWN` |
| `level` | `BEGINNER`, `INTERMEDIATE`, `ADVANCED` |
| `goal` | `EXAM`, `JOB`, `CURIOSITY` |
| `path_status` | `GATHERING`, `READING`, `MAPPING`, `AWAITING_BRANCH`, `BUILDING`, `READY`, `FAILED` |
| `resource_role` | `OFFICIAL`, `POPULAR` |
| `resource_type` | `DOCS`, `ARTICLE`, `VIDEO` |
| `concept_status` | `INCLUDED`, `SKIPPED` |
| `memory_scope` | `GLOBAL`, `TOPIC` |
| `memory_kind` | `LEVEL`, `STYLE`, `GOAL`, `UNDERSTOOD`, `FACT` |
| `memory_origin` | `LEVEL_CONFIRMED`, `LESSON_COMPLETED`, `CHAT_EXTRACTED`, `USER_EDITED` |

---

## 4. Core tables

### `users`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `clerk_user_id` | text | NOT NULL, UNIQUE |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

- Own `id` decouples all foreign keys from the auth provider
- No profile fields; Clerk is the source of truth
- Created on the first authenticated request

### `notebooks`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | FK → users, CASCADE |
| `title` | text | NOT NULL |
| `kind` | `notebook_kind` | NOT NULL |
| `topic_id` | uuid | FK → topics, nullable, SET NULL |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

**Indexes:** `(user_id, updated_at DESC)`

### `sources`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `notebook_id` | uuid | FK → notebooks, CASCADE |
| `user_id` | uuid | FK → users, CASCADE |
| `type` | `source_type` | NOT NULL |
| `origin` | `source_origin` | NOT NULL, default `USER` |
| `title` | text | NOT NULL |
| `status` | `source_status` | NOT NULL, default `PENDING` |
| `error_code` | text | nullable |
| `error_message` | text | nullable |
| `url` | text | nullable |
| `storage_key` | text | nullable (R2 key, PDF only) |
| `content_hash` | text | NOT NULL |
| `extracted_text` | text | nullable |
| `extracted_locations` | jsonb | nullable (where pages / caption segments sit in `extracted_text`; lets job steps pass only the source ID) |
| `metadata` | jsonb | NOT NULL, default `{}` |
| `chunk_count` | int | NOT NULL, default 0 |
| `embedding_model` | text | nullable |
| `processing_started_at` | timestamptz | nullable (the sweeper's clock: set when a job claims the source and again at the start of every step) |
| `processing_run_id` | text | nullable (the job run that owns the source while `PROCESSING`: a retried step of that run keeps its claim, and every job write requires it, so a duplicate or superseded run can't write) |
| `processed_at` | timestamptz | nullable |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

**Constraints:**
- `UNIQUE (notebook_id, content_hash)`, which is DB-level dedupe that also stops double-click races
- `UNIQUE (storage_key)`: one uploaded file backs at most one source, so deleting a source can never delete another source's file (NULLs are distinct, so non-PDF sources are unaffected)

**Indexes:**
- `(notebook_id, created_at)`
- `(processing_started_at) WHERE status = 'PROCESSING'` (partial, for the sweeper)

**`content_hash` =** file hash (PDF) · normalized URL hash (website / YouTube) · content hash (text)

### `source_chunks`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `source_id` | uuid | FK → sources, CASCADE |
| `notebook_id` | uuid | NOT NULL (denormalized) |
| `chunk_index` | int | NOT NULL |
| `content` | text | NOT NULL (shown in citations) |
| `context_header` | text | NOT NULL ("Title › Section") |
| `embedding` | vector(1536) | NOT NULL |
| `search_vector` | tsvector | GENERATED ALWAYS, STORED |
| `token_count` | int | NOT NULL |
| `page_number` | int | nullable (PDF) |
| `start_seconds`, `end_seconds` | int | nullable (YouTube) |
| `heading_path` | text | nullable (website / text) |
| `char_start`, `char_end` | int | nullable (highlighting) |
| `created_at` | timestamptz | NOT NULL |

**Generated column:**
```sql
search_vector = to_tsvector('english', coalesce(context_header, '') || ' ' || content)
```

**Constraints:** `UNIQUE (source_id, chunk_index)`

**Indexes:**
- `HNSW (embedding vector_cosine_ops)`
- `GIN (search_vector)`
- `(notebook_id)`

**pgvector setting:** iterative index scans enabled, so notebook-filtered vector search always returns enough results

---

## 5. Chat tables

### `conversations`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `notebook_id` | uuid | FK → notebooks, CASCADE |
| `user_id` | uuid | FK → users, CASCADE |
| `lesson_id` | uuid | FK → lessons, nullable, SET NULL |
| `title` | text | NOT NULL |
| `summary` | text | nullable |
| `summarized_through_seq` | int | NOT NULL, default 0 |
| `memory_extracted_through_seq` | int | NOT NULL, default 0 |
| `last_message_at` | timestamptz | NOT NULL |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

**Indexes:** `(notebook_id, last_message_at DESC)`

- `lesson_id` set → chat is filtered to the sources cited by that lesson version

### `messages`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `conversation_id` | uuid | FK → conversations, CASCADE |
| `seq` | int | NOT NULL |
| `role` | `message_role` | NOT NULL |
| `content` | text | NOT NULL (with `[n]` markers) |
| `citations` | jsonb | NOT NULL, default `[]` |
| `status` | `generation_status` | NOT NULL, default `COMPLETE` |
| `trace_id` | text | nullable (Langfuse) |
| `feedback` | `feedback` | nullable |
| `created_at` | timestamptz | NOT NULL |

**Constraints:** `UNIQUE (conversation_id, seq)`

**Citation snapshot shape** (shared Zod schema, reused by lessons):
```json
{
  "marker": 1,
  "sourceId": "uuid",
  "sourceTitle": "ML Lecture Notes",
  "sourceType": "PDF",
  "snippet": "Regularization adds a penalty term…",
  "pageNumber": 12,
  "startSeconds": null,
  "headingPath": null,
  "charStart": null,
  "charEnd": null
}
```
Snapshots survive source reprocessing (new chunk IDs) and source deletion (the snippet is kept).

**Not stored here:** retrieved chunks, scores, rewritten queries. Those live in Langfuse via `trace_id`.

---

## 6. Learning tables

### `learning_paths`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `notebook_id` | uuid | FK → notebooks, CASCADE, UNIQUE |
| `user_id` | uuid | FK → users, CASCADE |
| `topic` | text | NOT NULL (user's original wording) |
| `level` | `level` | NOT NULL |
| `goal` | `goal` | NOT NULL |
| `status` | `path_status` | NOT NULL, default `GATHERING` |
| `branch_options` | jsonb | nullable |
| `selected_branch` | text | nullable |
| `hook` | jsonb | nullable: `{ what, why, example, origin }` |
| `error_code`, `error_message` | text | nullable |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

- `status` drives the progress UI; `AWAITING_BRANCH` = job paused for the user's branch pick
- `branch_options`: `[{ name, description }]`; the branch pick must match a `name`

### `path_resources`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `path_id` | uuid | FK → learning_paths, CASCADE |
| `source_id` | uuid | FK → sources, nullable, SET NULL |
| `role` | `resource_role` | NOT NULL |
| `resource_type` | `resource_type` | NOT NULL |
| `title` | text | NOT NULL |
| `url` | text | NOT NULL |

**Indexes:** `(path_id)`

### `concepts`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `path_id` | uuid | FK → learning_paths, CASCADE |
| `name` | text | NOT NULL |
| `description` | text | NOT NULL |
| `consensus_score` | numeric | NOT NULL |
| `status` | `concept_status` | NOT NULL |
| `skip_reason` | text | nullable |
| `module_id` | uuid | FK → modules, nullable, SET NULL |
| `position` | int | nullable |

**Indexes:** `(path_id)`, `(module_id, position)`

### `concept_coverage`
| Column | Type | Constraints |
|---|---|---|
| `concept_id` | uuid | FK → concepts, CASCADE |
| `path_resource_id` | uuid | FK → path_resources, CASCADE |

**PK:** `(concept_id, path_resource_id)`. This is the evidence behind every include/skip decision.

### `modules`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `path_id` | uuid | FK → learning_paths, CASCADE |
| `position` | int | NOT NULL |
| `title` | text | NOT NULL |
| `summary` | text | NOT NULL |
| `is_enabled` | boolean | NOT NULL, default true |
| `completed_at` | timestamptz | nullable |

**Constraints:** `UNIQUE (path_id, position)`

- Progress lives here because a path has one owner. A separate progress table is a future migration for shared/cached paths.

### `lessons`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `module_id` | uuid | FK → modules, CASCADE |
| `version` | int | NOT NULL |
| `content` | text | NOT NULL (markdown with `[n]`) |
| `citations` | jsonb | NOT NULL, default `[]` (same shape as messages) |
| `status` | `generation_status` | NOT NULL |
| `trace_id` | text | nullable |
| `model` | text | NOT NULL |
| `created_at` | timestamptz | NOT NULL |

**Constraints:** `UNIQUE (module_id, version)`. The latest version is shown; regenerate adds a new version.

---

## 7. Memory tables

### `topics`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | NOT NULL |
| `normalized_name` | text | NOT NULL, UNIQUE |
| `embedding` | vector(1536) | NOT NULL |
| `created_at` | timestamptz | NOT NULL |

**Indexes:** `HNSW (embedding vector_cosine_ops)`

- Shared across users (topic names aren't personal); each topic embedded once
- Synonyms are **related by similarity, never merged**

### `memories`
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | FK → users, CASCADE |
| `scope` | `memory_scope` | NOT NULL |
| `topic_id` | uuid | FK → topics, nullable |
| `kind` | `memory_kind` | NOT NULL |
| `content` | text | NOT NULL |
| `level` | `level` | nullable |
| `concept_id` | uuid | FK → concepts, nullable, SET NULL |
| `origin` | `memory_origin` | NOT NULL |
| `origin_ref` | uuid | nullable |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

**Constraints:**
- `CHECK`: `scope = 'TOPIC'` ⇔ `topic_id IS NOT NULL`
- `CHECK`: `kind = 'LEVEL'` ⇒ `level IS NOT NULL` and `scope = 'TOPIC'`
- `UNIQUE (user_id, topic_id) WHERE kind = 'LEVEL'` (one level per topic)
- `UNIQUE (user_id, concept_id) WHERE kind = 'UNDERSTOOD'` (one per concept)

**Indexes:** `(user_id, scope, topic_id)`

**Rules (enforced in code):**
- `STYLE` / `GOAL` / `FACT`: the extraction job sees existing memories and decides add / update by ID / skip
- `origin = USER_EDITED` → never overwritten by the extraction job
- Cap of 200 memories per user (config)
- Deleting a notebook does **not** delete memories

---

## 8. Key transactions & queries

### Atomic indexing (end of `processSource`)
```sql
BEGIN;
  DELETE FROM source_chunks WHERE source_id = $1;
  INSERT INTO source_chunks (...) VALUES (...), (...);
  UPDATE sources
     SET status = 'READY', chunk_count = $2, embedding_model = $3, processed_at = now()
   WHERE id = $1;
COMMIT;
```

### Summary update (optimistic concurrency)
```sql
UPDATE conversations
   SET summary = $1, summarized_through_seq = $2
 WHERE id = $3 AND summarized_through_seq = $4;  -- old value
```
0 rows updated → another job already did it → do nothing.

### Hybrid search (shape)
```
vector:  ORDER BY embedding <=> $query_vec, WHERE notebook_id = $1 [AND source_id IN (...)], LIMIT 40
keyword: WHERE notebook_id = $1 AND search_vector @@ query, ORDER BY ts_rank, LIMIT 40
→ both run in parallel → fused with RRF in app code
```

### Stuck sources (sweeper)
```sql
UPDATE sources
   SET status = 'FAILED', error_code = 'TIMEOUT', error_message = 'Processing timed out, please retry.'
 WHERE status = 'PROCESSING' AND processing_started_at < now() - interval '15 minutes';
```

The clock restarts at the start of every job step, so time spent across earlier steps doesn't add up. **Known limit:** the database can't tell a run whose next step is waiting in the job queue from a dead run, so a step that waits more than 15 minutes before starting (a job backlog of that length) is timed out too, and the user retries. At current concurrency that takes well over a hundred sources queued ahead. The full fix is for the sweeper to ask the job service whether the run (`processing_run_id`) is still alive before failing it (`docs/todo-v2.md`).

A source still `PENDING` after 10 minutes never got a job run. The sweeper sends its event again and touches `updated_at`, so the same source isn't re-sent until another 10 minutes pass:
```sql
UPDATE sources SET updated_at = now()
 WHERE id IN (SELECT id FROM sources
               WHERE status = 'PENDING' AND updated_at < now() - interval '10 minutes'
               ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED)
RETURNING id, user_id;
```

---

## 9. Deletion behavior

| Deleted | Effect |
|---|---|
| **User** | Everything they own (cascade) |
| **Notebook** | Sources → chunks; conversations → messages; learning path → resources, concepts, coverage, modules, lessons. **Memories kept.** |
| **Source** | Chunks (cascade); `path_resources.source_id` → null; R2 file deleted by app code afterwards (failure logged as orphan) |
| **Lesson version** | `conversations.lesson_id` → null |
| **Concept** | `memories.concept_id` → null; memory text kept |

**Citations are snapshots**, so no deletion ever breaks an old message or lesson.
