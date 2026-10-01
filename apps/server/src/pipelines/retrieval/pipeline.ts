import type { RetrievalFlags } from '../../config/index.js';
import { retrieval } from '../../config/index.js';
import type { LlmMessage } from '../../lib/llm/index.js';
import { fuseRankLists } from './fusion.js';
import { retrieve, type RetrievalDeps, type RetrievedChunk } from './retrieve.js';

/** Step 1's structured output (docs/02-system-design.md §7). */
export interface QueryUnderstanding {
  /** False for "thanks!": nothing is searched. */
  needsRetrieval: boolean;
  /** The question rewritten to stand alone (follow-ups resolved against the history). */
  standaloneQuery: string;
  /** Separate searches for a question with several parts; empty when one search is enough. */
  subQueries: string[];
}

/** Steps 1, 2 (keyword half) and 4: built in 6.2–6.4, each used only when its flag is on. */
export interface RetrievalStepDeps {
  understandQuery?: (input: {
    question: string;
    history: LlmMessage[];
  }) => Promise<QueryUnderstanding>;
  /** Best match first, scoped like `vectorSearch`. */
  keywordSearch?: (params: {
    userId: string;
    notebookId: string;
    query: string;
    limit: number;
  }) => Promise<RetrievedChunk[]>;
  /** Returns at most `topK` of `chunks`, most relevant first. */
  rerank?: (input: {
    query: string;
    chunks: RetrievedChunk[];
    topK: number;
  }) => Promise<RetrievedChunk[]>;
}

/** Runs one step; chat wraps each in a trace span. Defaults to calling `fn`. */
export type StepRunner = <T>(name: string, input: unknown, fn: () => Promise<T>) => Promise<T>;

export interface RetrievalPipelineDeps extends RetrievalDeps, RetrievalStepDeps {
  flags: RetrievalFlags;
  step?: StepRunner;
  /** An optional step failed and was skipped (graceful degradation); the caller logs it. */
  onStepFailed?: (step: OptionalStep, error: unknown) => void;
}

export type OptionalStep = 'understand';

export interface RetrievalPipelineInput {
  userId: string;
  notebookId: string;
  question: string;
  /** Recent messages, oldest first, without the new question (for the rewrite). */
  history: LlmMessage[];
  /** Chunks returned. Defaults to `retrieval.rerankTopK`. */
  topK?: number;
}

export interface RetrievalPipelineResult {
  /** False when routing decided nothing needs searching; `chunks` is then empty. */
  retrieved: boolean;
  /** The searches that ran: the question (or its rewrite), then any sub-queries. */
  queries: string[];
  /** Best first, ranks 1…n. */
  chunks: RetrievedChunk[];
  /** Which optional steps ran, for traces and the eval results. */
  steps: { understand: boolean; keyword: boolean; fusion: boolean; rerank: boolean };
  /** Optional steps that failed and were skipped. */
  failed: OptionalStep[];
}

const runDirectly: StepRunner = (_name, _input, fn) => fn();

/**
 * Steps 1–4 of the chat pipeline (docs/02-system-design.md §7): query understanding → vector
 * (+ keyword) search per query → fusion → rerank. Every optional step sits behind its feature
 * flag (R-07), so the eval can measure each one: with every flag off this is exactly the
 * vector-only baseline.
 *
 * - `queryRewrite` / `subQueries`: either one turns on the understanding call. `queryRewrite`
 *   searches the standalone query instead of the raw question and lets routing skip the search;
 *   `subQueries` adds a search per sub-query.
 * - `hybridSearch`: adds a keyword search next to each vector search.
 * - Fusion (RRF) runs only when there is more than one result list to merge.
 * - `rerank`: reorders the fused candidates; without it they are cut to `topK` in fused order.
 *
 * Flag on without its step's dep is a wiring bug: it throws before anything is called.
 * A failing understanding call doesn't fail the request: the raw question is searched.
 */
export async function runRetrieval(
  input: RetrievalPipelineInput,
  deps: RetrievalPipelineDeps,
): Promise<RetrievalPipelineResult> {
  const { flags } = deps;
  const step = deps.step ?? runDirectly;
  const topK = input.topK ?? retrieval.rerankTopK;
  requireStepDeps(deps);

  const understandOn = flags.queryRewrite || flags.subQueries;
  const steps = { understand: false, keyword: false, fusion: false, rerank: false };
  const failed: OptionalStep[] = [];

  let searchQuery = input.question;
  let subQueries: string[] = [];
  if (understandOn && deps.understandQuery) {
    const understandQuery = deps.understandQuery;
    const understood = await step('understand', { question: input.question }, () =>
      understandQuery({ question: input.question, history: input.history }),
    ).catch((error: unknown) => {
      failed.push('understand');
      deps.onStepFailed?.('understand', error);
      return null;
    });
    if (understood) {
      steps.understand = true;
      if (flags.queryRewrite) {
        if (!understood.needsRetrieval) {
          return { retrieved: false, queries: [], chunks: [], steps, failed };
        }
        searchQuery = understood.standaloneQuery.trim() || input.question;
      }
      if (flags.subQueries) subQueries = understood.subQueries;
    }
  }

  const queries = dedupe([searchQuery, ...subQueries]);
  const keywordSearch = flags.hybridSearch ? deps.keywordSearch : undefined;
  steps.keyword = keywordSearch !== undefined;

  const lists = await step('search', { queries }, () =>
    Promise.all(
      queries.flatMap((query) => [
        retrieve(
          {
            userId: input.userId,
            notebookId: input.notebookId,
            query,
            limit: retrieval.vectorCandidates,
          },
          deps,
        ),
        ...(keywordSearch
          ? [
              keywordSearch({
                userId: input.userId,
                notebookId: input.notebookId,
                query,
                limit: retrieval.vectorCandidates,
              }),
            ]
          : []),
      ]),
    ),
  );

  let candidates: RetrievedChunk[];
  if (lists.length > 1) {
    steps.fusion = true;
    candidates = fuseRankLists(lists, { k: retrieval.rrfK, limit: retrieval.fusionCandidates });
  } else {
    candidates = lists[0] ?? [];
  }

  let chunks: RetrievedChunk[];
  if (flags.rerank && deps.rerank && candidates.length > 0) {
    const rerank = deps.rerank;
    steps.rerank = true;
    chunks = await step('rerank', { query: searchQuery, candidates: candidates.length }, () =>
      rerank({ query: searchQuery, chunks: candidates, topK }),
    );
  } else {
    chunks = candidates.slice(0, topK);
  }

  return { retrieved: true, queries, chunks: renumber(chunks), steps, failed };
}

function requireStepDeps(deps: RetrievalPipelineDeps) {
  const { flags } = deps;
  const missing = [
    (flags.queryRewrite || flags.subQueries) && !deps.understandQuery && 'understandQuery',
    flags.hybridSearch && !deps.keywordSearch && 'keywordSearch',
    flags.rerank && !deps.rerank && 'rerank',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Retrieval flags are on without their steps: ${missing.join(', ')}`);
  }
}

function dedupe(queries: string[]): string[] {
  const seen = new Set<string>();
  return queries
    .map((query) => query.trim())
    .filter((query) => {
      const key = query.toLowerCase();
      if (query === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function renumber(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return chunks.map((chunk, index) => ({ ...chunk, rank: index + 1 }));
}
