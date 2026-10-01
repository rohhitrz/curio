# Evals

The golden dataset and the tools around it (test plan §6): retrieval metrics (hit rate@k, MRR,
Phase 4) and answer metrics (faithfulness, correctness, citation accuracy, refusals, Phase 5).

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
pnpm eval                          # retrieval + answer metrics (answers averaged over 2 runs)
pnpm eval -- --retrieval-only      # retrieval metrics only: no LLM calls, under a cent
pnpm eval -- --runs=1              # one answer run
pnpm eval -- --only=q-001,q-061    # smoke test: these questions only, printed, no results file
pnpm eval -- --flags=queryRewrite  # ablation: exactly these retrieval flags on (default: the app's)
```

Results go to `results/<date>-<config>.json`, where `<config>` is `vector` plus every flag that
was on (`vector+queryRewrite+hybridSearch`). A `--retrieval-only` run adds `-retrieval`, so it
never overwrites that day's full run.

1. Replaces the eval notebook (owner `eval_runner`) in the Neon `dev` database; refuses to run if
   `DATABASE_URL` is the production or test database.
2. Ingests every document through the real ingestion service (extract → chunk → embed → commit),
   with R2, Firecrawl and Supadata replaced by the local cache. Embeddings are real OpenAI calls.
3. Asks every question through the real retrieval pipeline (`runRetrieval`, with the run's flags; top 10) and marks each retrieved chunk
   relevant or not by location.
4. Answers every question through the real generation step (the top 8 chunks, as chat uses
   them; follow-ups get their `history`), twice by default, and grades each answer:
   - **Faithfulness** (judge, `judges/faithfulness.md`): the answer is split into claims and each is
     checked against the sources it cites. Supported claims ÷ all claims, over non-refusals.
   - **Correctness** (judge, `judges/correctness.md`): 1–5 against `expectedAnswer`; mean and the
     share scoring ≥ 4. A refusal of an answerable question scores 1 without a judge call.
   - **Citation accuracy** (code): cited chunks at an expected location ÷ all citations.
   - **Refusal accuracy** / **false refusal rate** (code): the answer is exactly the
     "not in your sources" reply.

   The generator is the chat model (Luna); the judge is `evalJudge` (Sol), both from
   `apps/server/src/config/models.ts`.

5. Writes `results/<date>-<config>.json`: retrieval metrics (over the top 10) and answer metrics
   (averaged over runs, plus each run), overall and per category, the git commit, the models, the
   cost per model, and every question's retrieved chunks, answers, citations and judge verdicts.

`<config>` is `vector` plus each retrieval flag that is on (`apps/server/src/config/flags.ts`).
Follow-up questions are searched as asked (their `history` only reaches the answer step) until
query rewrite exists. A full run costs about a dollar; `--retrieval-only` well under a cent.

## Other commands

All run from the repo root. Only `fetch-docs` and `eval` use the network; only `eval` calls an LLM.

```bash
pnpm --filter @curio/evals fetch-docs   # fetch missing documents into .cache/, check hashes
pnpm --filter @curio/evals check        # validate the dataset against the chunks ingestion produces
pnpm --filter @curio/evals review       # write .cache/review.md: every question with its source text
pnpm --filter @curio/evals preview      # write .cache/preview/<doc>.md: every chunk of every document
```

`check` fails if any expected location matches no chunk, which catches a wrong page or a
mistyped heading path before it silently scores zero.
