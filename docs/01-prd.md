# Curio — Product Requirements Document (v1)

> **Status:** Approved
> **Name:** Curio (working name, final name TBD)
> **Scope:** v1 only. Nothing under "Future ideas" is built.

---

## 1. Overview

Curio is an AI learning workspace with **two entry points**:

1. **"I have material"**: bring your own sources (PDFs, YouTube, websites, notes) and chat with them, getting grounded, cited answers.
2. **"I have a topic"**: tell Curio what you want to learn; it builds a focused learning path from trusted resources and teaches it through generated, cited lessons.

**Core differentiator:** a reliable ingestion pipeline and an advanced retrieval pipeline, with quality **measured by evals**, not assumed.

---

## 2. Problem

- Learners' material is **scattered** across PDFs, videos, and websites
- Generic AI chatbots give **confident answers that aren't grounded** in any trusted source
- When starting a new topic, learners **don't know what to learn or in what order**. There's too much content and no filter for what matters at their level.

---

## 3. Users

**Primary user: the self-directed learner**, someone who wants to *actually understand* a topic.

- **Students:** have lecture notes/PDFs and need to understand them for exams
- **Working professionals:** need to pick up a new skill for work
- **The curious:** served by the same product; not designed for separately

**Quality bar this implies:** accurate, cited, well-structured answers. A plain chatbot is not enough.

---

## 4. Goals & Non-goals

### Goals
- Reliable ingestion: every source ends as **ready** or **failed with a reason**
- High-quality, cited RAG answers, with improvements **proven by evals**
- A learning-path framework that is **consistent, explainable, and evaluable**
- Personalization through long-term memory, without compromising grounding
- A codebase and design the owner can fully explain

### Non-goals (v1)
- Podcast / PPT / audio generation
- Quizzes, flashcards, summaries as separate artifacts
- Live web search inside regular chat
- Sharing, collaboration, mobile app, payments
- Building for massive scale now (it's *designed* to scale, *built* for realistic load)

---

## 5. Features (v1)

### 5.1 Auth
- Sign in with **Clerk**
- A user can only ever access their own notebooks, sources, conversations, lessons, and memories

### 5.2 Notebooks
- Create, rename, delete notebooks
- Each notebook is an **isolated knowledge base**: chat only searches that notebook's sources
- Two kinds:
  - **Source notebook:** the user brings material
  - **Learning notebook:** created from a learning path (section 5.6)
- Deleting a notebook removes all its sources, vectors, conversations, and lessons

### 5.3 Sources

**Supported types**
- PDF upload
- Website URL
- YouTube link (via transcript)
- Pasted text / markdown
- Web resources added from a learning path

**Behavior**
- Adding a source **never blocks the UI**; processing happens in the background
- Visible status: `PENDING → PROCESSING → READY` or `FAILED`
- A failed source shows a **human-readable reason** and can be **retried**
- A source can be deleted, and it's **fully removed from search**
- No duplicates: re-adding the same source is detected
- A user can view a source's content and its chunks (for transparency and debugging)

### 5.4 Ingestion (reliability requirements)
- Parsing is tailored per source type, preserving what citations need:
  - PDF → **page numbers**
  - YouTube → **timestamps**
  - Website / text → **section / position**
- A source is never left **half-indexed**: it's either fully searchable or not searchable at all
- Transient failures (network, rate limits) are **retried automatically** before marking as failed
- Nothing is ever stuck in `PROCESSING` indefinitely

### 5.5 RAG chat
- Chat within a notebook, answering **only from that notebook's `READY` sources**
- **Advanced retrieval** is a core requirement (e.g. query transformation, reranking). Exact techniques are chosen in system design, and **each must show measured improvement in evals**.
- **Every factual claim is cited**
- Citations are **clickable** and open the exact location:
  - PDF → the page
  - YouTube → the timestamp
  - Website / text → the highlighted passage
- If the answer isn't in the sources, Curio says so and **doesn't invent** one
- Responses **stream**
- Conversations are saved per notebook; the user can create, list, open, and delete them
- Long conversations stay coherent through a **rolling summary** of older messages

### 5.6 Learn a topic

**Flow**
1. **Clarify:** user enters a topic; Curio asks for **level** (beginner / intermediate / advanced) and **goal** (exam, job, curiosity)
   - Level is **per topic**. If memory holds a level for the same or a related topic, Curio **pre-fills it and asks the user to confirm**; it never assumes
   - **Scope check:** a topic too broad for one focused path (e.g. "science", "programming") gets 4–6 narrower focus options to pick from; the user can keep the original. A failed check never blocks
2. **Gather:** finds **official docs** (source of truth) plus a capped number of **popular resources** (tutorials, articles, videos)
3. **Map:** extracts the concepts each resource covers and scores them by **consensus** (how many resources cover them, plus the LLM's own knowledge of the topic as one lighter vote; the official docs weigh the most); the LLM sets **prerequisite order** and fills gaps
4. **Cut by level:**
   - **Beginner:** high-consensus concepts only, a gist of everything, breadth over depth
   - **Intermediate:** core plus the next layer, more specific
   - **Advanced:** user **picks a branch**, which is covered in depth
5. **Present the path:**
   - A **hook** first: what it is, why it matters, one real-world example, a 2-line origin
   - **Modules** in prerequisite order, each with **why it matters**, a relative **difficulty**, and an **estimated time**; the number of modules follows the topic's breadth
   - A **"Skipped for now"** list, so nothing important is silently dropped
6. **Edit:** the user can check or uncheck modules before starting
7. **Create:** a **learning notebook** is created, and the chosen resources are ingested as its sources
   - While building, the progress screen names the resources being read and mapped
8. **Learn in the classroom:** one screen with the modules on one side and the open module's lesson + tutor on the other. Curio is the teacher: it has studied the resources, so the learner doesn't need to open them; they sit in a collapsed **"What your teacher studied"** list. "Start learning" opens the first module not yet done

### 5.7 Lessons
- Generated **on demand**: opening a module shows its saved lesson, or starts streaming one right away (no "generate" button), not all upfront
- **Lessons teach, they don't summarize.** Structure: a short intro (why this module matters, how it builds on the last) → **one section per concept**: intuition first, then the precise idea, then a **worked example** (short runnable code for technical topics; a concrete case, scenario or table otherwise), then a common misconception where there is one → **Key takeaways**
- **Grounded via RAG** in the notebook's sources: every factual claim is cited `[n]`; sources appear only as citations (and a list built from them), never as "go read this". The LLM's own knowledge only connects and explains: **examples, analogies and code are the teacher's own** and must agree with the sources
- A concept **no source covers** (the model's own list or a gap prerequisite) is still taught, briefly and without citations, under a visible note: *"General knowledge, not in the resources"*
- Adapted to the user's **level and learning style**
- Saved once generated; a **regenerate** option is available
- **Tutor per module** (the "ask about this" chat): searches only the lesson's cited sources, knows the lesson, the module and the rest of the path, and **stays on the module's topic** (off-topic questions get a short redirect). When the learner seems ready, it **suggests** marking the module done; the learner clicks
- **Mark as done** saves progress and updates topic memory (e.g. *"understands X"*)

### 5.8 Long-term memory

**What's stored**
- **Global facts:** learning style, goals, background, language preference
- **Topic-scoped facts:** level and understood concepts, **tagged by topic**

**Rules**
- **Memory personalizes, sources ground.** Memory changes *how* Curio explains, never *what's true*; citations come only from sources
- **Facts about the learner only**, never content from their sources
- The user can **view, edit, and delete** their memories on a memory page
- Memory is **per user, shared across notebooks**, with topic tags keeping facts correctly scoped

---

## 6. Key user flows

**Flow A: Bring your own material**
Sign in → create notebook → add PDF + YouTube link → watch status move to `READY` → ask a question → get a streamed, cited answer → click a citation → PDF opens at the page

**Flow B: Learn a topic**
Sign in → "Learn a topic" → type "Machine Learning" → answer level/goal (a too-broad topic offers focus options) → learning notebook is created, resources read and mapped (progress names them) → review the path (hook, modules with why / difficulty / time, skipped list) → uncheck a module → "Start learning" → the classroom opens module 1 → the lesson streams with citations → ask the tutor a question → mark done

**Flow C: Recovering from failure**
Add a website that fails to scrape → source shows `FAILED` with a reason → user retries or deletes it → the rest of the notebook works normally

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| **Reliability** | Every source ends as `READY` or `FAILED` with a reason; automatic retries for transient errors; no half-indexed sources |
| **Performance** | Chat first token in ~3–6s, streamed (was < ~3s; see R-12); lessons stream; indexing runs in the background |
| **Quality** | Every answer cited or "not in your sources"; RAG evals with a tracked baseline |
| **Observability** | Each chat request is traceable end-to-end (query → retrieval → answer) with latency, tokens, and cost; background jobs logged |
| **Security** | Clerk auth; strict per-user data isolation on every request |
| **Limits** | Max file size, max sources per notebook, rate limits on chat and path generation (exact values set in system design) |
| **Scale** | Built for hundreds of users; system design documents what would change at much larger scale |

---

## 8. Constraints

- **Auth:** Clerk
- **Default LLM:** GPT-6 Luna; model is **configurable per task**, and heavier tasks (path/lesson generation) can be upgraded if evals show the need
- **Hosting:** Vercel, so long-running work must go through background jobs
- **Budget:** free tiers wherever possible (database, vector DB, jobs, observability, search); pay only for LLM usage, protected by rate limits
- **Process:** docs before code; the owner approves each doc; changes update the doc first, then the code
- **Git:** after each meaningful step, the agent commits with a clear Conventional Commits message and pushes, using the owner's existing git setup; no Claude co-author or attribution

---

## 9. Success metrics (v1 definition of done)

- **Ingestion:** > 95% of sources index successfully on the first attempt; **zero** stuck in `PROCESSING`
- **Retrieval:** hit rate and faithfulness measured on an eval set; each advanced technique shows **measured improvement** over the baseline
- **Citations:** 100% of answers are cited or explicitly say "not in your sources"
- **Speed:** chat first token ~3–6s, measured on every chat trace (`firstTokenMs`). Was < ~3s; relaxed for better multi-part answers and refusals (decision R-12)
- **Learning path:** beginner paths cover the core sections of the official docs (checked by evals)
- **Ownership:** the owner can explain every major decision via the decision log

---

## 10. Future ideas (not built in v1)

- Quizzes, flashcards, summaries
- Live web search inside regular chat
- Podcast and PPT generation (from old Curio)
- Sharing notebooks
- Mobile app

---

## 11. Open decisions (for system design)

- Backend shape: separate Express server or Next.js API routes
- Vector DB: Pinecone or pgvector
- Embedding model
- Memory implementation: Mem0 or custom
- Exact advanced-RAG techniques and their eval plan
- Exact limits (file size, sources per notebook, rate limits)
- Final product name
