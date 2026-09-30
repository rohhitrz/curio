# Evals

The golden dataset and the tools around it (test plan §6). Phase 4 builds the retrieval
metrics (hit rate@k, MRR); answer metrics come in Phase 5.

## Dataset (`dataset/`)

- **`documents.json`**: 7 documents on one theme (ML fundamentals), covering all four source types:
  2 PDFs, 2 websites, 2 YouTube videos, 1 text note. Documents on one theme overlap (regularization
  appears in five of them), which makes retrieval harder, so the numbers are realistic.
- **`questions.jsonl`**: one question per line. Categories: `factual`, `exact-term` (numbers, names,
  codes: keyword search), `multi-part` (needs several searches: sub-queries), `follow-up` (only
  makes sense with `history`: query rewrite), `unanswerable` (not in any document: the right answer
  is a refusal).
- **`notes/gradient-descent.md`**: the text document, original content written for this dataset.

### Expected locations

Relevance is judged by location, not chunk ID, so results stay comparable when chunking changes
(`src/relevance.ts`):

| Source         | Location                     | A chunk is relevant when                                             |
| -------------- | ---------------------------- | -------------------------------------------------------------------- |
| PDF            | `pageNumber`                 | it is on that page                                                   |
| YouTube        | `startSeconds`, `endSeconds` | its time range overlaps the window                                   |
| Website / text | `headingPath`                | its heading path is exactly this (`null` = before the first heading) |

## Third-party content stays out of git

PDFs, scraped pages and transcripts are fetched into `.cache/` (gitignored). `documents.json`
records each one's URL and the SHA-256 of what was fetched, so a changed upstream page is noticed
instead of silently shifting the numbers.

## Running the eval

```bash
pnpm eval
```

1. Replaces the eval notebook (owner `eval_runner`) in the Neon `dev` database; refuses to run if
   `DATABASE_URL` is the production or test database.
2. Ingests every document through the real ingestion service (extract → chunk → embed → commit),
   with R2, Firecrawl and Supadata replaced by the local cache. Embeddings are real OpenAI calls.
3. Asks every question through the real retrieval module (top 10) and marks each retrieved chunk
   relevant or not by location.
4. Writes `results/<date>-<config>.json`: hit rate@5 and @10 and MRR (over the top 10) for the
   answerable questions, overall and per category, the git commit, the models, the cost, and
   every question's retrieved chunks with their scores.

`<config>` is `vector` plus each retrieval flag that is on (`apps/server/src/config/flags.ts`).
Follow-up questions are searched as asked (their `history` is ignored) until query rewrite exists.
A run costs well under a cent and takes about 3 minutes.

## Other commands

All run from the repo root. Only `fetch-docs` and `eval` use the network; nothing here calls an LLM
for text generation yet.

```bash
pnpm --filter @curio/evals fetch-docs   # fetch missing documents into .cache/, check hashes
pnpm --filter @curio/evals check        # validate the dataset against the chunks ingestion produces
pnpm --filter @curio/evals review       # write .cache/review.md: every question with its source text
pnpm --filter @curio/evals preview      # write .cache/preview/<doc>.md: every chunk of every document
```

`check` fails if any expected location matches no chunk, which catches a wrong page or a
mistyped heading path before it silently scores zero.
