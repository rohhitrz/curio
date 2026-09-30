import { SOURCE_TITLE_MAX } from '@curio/shared';
import type { Logger } from 'pino';
import { IngestionError, type SourceErrorCode } from '../errors/ingestion-error.js';
import type { EmbeddingsProvider } from '../lib/embeddings/index.js';
import { chunkContent, type ChunkOptions } from '../pipelines/ingestion/chunk.js';
import {
  extractSource,
  type ExtractionDeps,
  type Extraction,
} from '../pipelines/ingestion/extract.js';
import { fromStored, toStored } from '../pipelines/ingestion/stored-content.js';
import type { IngestionRepository, SourceRef } from '../repositories/ingestion.repository.js';
import { websitePlaceholderTitle, youtubePlaceholderTitle } from './source-identity.js';

/**
 * How a job step ended. `stopped` ends the job without an error: the source was deleted, or it
 * failed for good and is already marked `FAILED`. Anything worth retrying is thrown instead.
 */
export type StepResult =
  | { status: 'ok'; chunkCount?: number }
  | { status: 'stopped'; reason: 'not_found' }
  | { status: 'stopped'; reason: 'failed'; code: SourceErrorCode };

export interface StepAttempt {
  /** True on the last try: a transient failure now fails the source instead of being thrown. */
  isLastAttempt: boolean;
}

export interface IngestionDeps extends ExtractionDeps {
  repository: IngestionRepository;
  embeddings: EmbeddingsProvider;
  logger: Logger;
  chunking: Pick<ChunkOptions, 'targetTokens' | 'overlapRatio' | 'countTokens'>;
}

const NOT_FOUND: StepResult = { status: 'stopped', reason: 'not_found' };

const messages = {
  hashMismatch: "The uploaded file doesn't match what was registered. Please upload it again.",
  nothingToIndex: 'No readable text was found in this source.',
  unexpected: 'Something went wrong while processing this source. Please try again.',
};

interface SourceForTitle {
  type: string;
  title: string;
  url: string | null;
  metadata: Record<string, unknown>;
}

/** True while the source still has the title we made up when it was added. */
function hasPlaceholderTitle(source: SourceForTitle): boolean {
  if (source.type === 'WEBSITE' && source.url !== null) {
    return source.title === websitePlaceholderTitle(source.url, SOURCE_TITLE_MAX);
  }
  if (source.type === 'YOUTUBE' && typeof source.metadata.videoId === 'string') {
    return source.title === youtubePlaceholderTitle(source.metadata.videoId);
  }
  return false;
}

/** The text that is embedded: the context header gives an ambiguous chunk its subject. */
function embeddingInput(chunk: { contextHeader: string; content: string }): string {
  return `${chunk.contextHeader}\n\n${chunk.content}`;
}

export function createIngestionService(deps: IngestionDeps) {
  const { repository, embeddings, logger } = deps;

  /**
   * Runs a step. A permanent failure marks the source `FAILED` with its reason and stops the
   * job; a transient or unexpected one is thrown so the step is retried, until the last attempt,
   * when it fails the source too. So a source never stays `PROCESSING` after its job ends.
   */
  async function guarded(
    ref: SourceRef,
    step: string,
    { isLastAttempt }: StepAttempt,
    work: () => Promise<StepResult>,
  ): Promise<StepResult> {
    try {
      return await work();
    } catch (err) {
      const known = err instanceof IngestionError;
      if (!isLastAttempt && (!known || err.retryable)) {
        logger.warn({ err, ...ref, step }, 'ingestion step failed, will retry');
        throw err;
      }

      const code = known ? err.code : 'PROCESSING_FAILED';
      const message = known ? err.message : messages.unexpected;
      // Our own faults (bad key, no credits, a bug) need the owner's attention.
      const level = code === 'PROCESSING_FAILED' ? 'error' : 'warn';
      logger[level]({ err, ...ref, step, code }, 'source failed');

      const marked = await repository.markFailed(ref, code, message);
      return marked ? { status: 'stopped', reason: 'failed', code } : NOT_FOUND;
    }
  }

  /** The extracted content chunked with the current settings. Undefined when the source is gone. */
  async function loadChunks(ref: SourceRef) {
    const source = await repository.findExtracted(ref);
    if (!source) return undefined;
    const content = fromStored(source.extractedText ?? '', source.extractedLocations);
    const { chunks } = chunkContent(content, { title: source.title, ...deps.chunking });
    if (chunks.length === 0) throw IngestionError.permanent('NO_TEXT', messages.nothingToIndex);
    return chunks;
  }

  function assertSameFile(contentHash: string, extraction: Extraction): void {
    const { fileHash } = extraction.metadata;
    if (typeof fileHash === 'string' && fileHash !== contentHash.toLowerCase()) {
      throw IngestionError.permanent('INVALID_FILE', messages.hashMismatch);
    }
  }

  return {
    /** Step 1: claim the source (`PROCESSING`). */
    async start(ref: SourceRef): Promise<StepResult> {
      return (await repository.markProcessing(ref)) ? { status: 'ok' } : NOT_FOUND;
    },

    /** Step 2: read the source and save its text and locations. */
    extract(ref: SourceRef, attempt: StepAttempt): Promise<StepResult> {
      return guarded(ref, 'extract', attempt, async () => {
        const source = await repository.findForExtraction(ref);
        if (!source) return NOT_FOUND;

        const extraction = await extractSource(source, deps);
        if (source.type === 'PDF') assertSameFile(source.contentHash, extraction);

        const { text, locations } = toStored(extraction.content);
        const title = extraction.title?.slice(0, SOURCE_TITLE_MAX);
        const saved = await repository.saveExtraction(ref, {
          // A title the user typed is never replaced.
          ...(title && hasPlaceholderTitle(source) && { title }),
          extractedText: text,
          extractedLocations: locations,
          metadata: { ...source.metadata, ...extraction.metadata },
        });
        return saved ? { status: 'ok' } : NOT_FOUND;
      });
    },

    /** Step 3: chunk. Nothing is stored yet; this fails early when there is nothing to index. */
    chunk(ref: SourceRef, attempt: StepAttempt): Promise<StepResult> {
      return guarded(ref, 'chunk', attempt, async () => {
        const chunks = await loadChunks(ref);
        return chunks ? { status: 'ok', chunkCount: chunks.length } : NOT_FOUND;
      });
    },

    /**
     * Steps 4 and 5: embed the chunks, then replace the old ones and mark the source `READY` in
     * one transaction. They share a step because vectors are too big to pass between steps.
     */
    embedAndCommit(ref: SourceRef, attempt: StepAttempt): Promise<StepResult> {
      return guarded(ref, 'embed-and-commit', attempt, async () => {
        const chunks = await loadChunks(ref);
        if (!chunks) return NOT_FOUND;

        const vectors = await embeddings.embed(chunks.map(embeddingInput));
        const rows = chunks.map((chunk, index) => {
          const embedding = vectors[index];
          if (!embedding) throw new Error(`no embedding for chunk ${index}`);
          return { ...chunk, embedding };
        });

        const committed = await repository.commitChunks(ref, rows, embeddings.model);
        return committed ? { status: 'ok', chunkCount: rows.length } : NOT_FOUND;
      });
    },

    /** Safety net for a job that ended without marking its source: fail it generically. */
    async fail(ref: SourceRef): Promise<void> {
      await repository.markFailed(ref, 'PROCESSING_FAILED', messages.unexpected);
    },
  };
}

export type IngestionService = ReturnType<typeof createIngestionService>;
