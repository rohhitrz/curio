import type {
  CreateSourceInput,
  CreateUploadInput,
  FileUrlResponse,
  Source,
  SourceChunkList,
  SourceContent,
  SourceList,
  UploadResponse,
} from '@curio/shared';
import { SOURCE_TITLE_MAX } from '@curio/shared';
import type { Logger } from 'pino';
import { quotas, uploads } from '../config/index.js';
import {
  AppError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../errors/app-error.js';
import type { JobsProvider } from '../lib/jobs/index.js';
import type { StorageProvider } from '../lib/storage/index.js';
import { decodeIndexCursor, encodeIndexCursor } from '../pagination/cursor.js';
import type {
  NewSource,
  SourceRow,
  SourcesRepository,
} from '../repositories/sources.repository.js';
import {
  canonicalYouTubeUrl,
  normalizeText,
  normalizeUrl,
  parseYouTubeVideoId,
  sha256Hex,
  websitePlaceholderTitle,
  youtubePlaceholderTitle,
} from './source-identity.js';
import {
  assertPdfSize,
  assertUploadAllowed,
  isOwnUploadKey,
  newUploadKey,
} from './upload-rules.js';

/** Explicit fields, so internal columns (e.g. `storageKey`) never leak into responses. */
function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    notebookId: row.notebookId,
    type: row.type,
    origin: row.origin,
    title: row.title,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    url: row.url,
    chunkCount: row.chunkCount,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

const notebookNotFound = () => new NotFoundError('Notebook not found.');
const sourceNotFound = () => new NotFoundError('Source not found.');

const quotaExceeded = () =>
  new AppError(
    'QUOTA_EXCEEDED',
    `A notebook can have up to ${quotas.sourcesPerNotebook} sources. Delete one to add another.`,
  );

const uploadNotFound = () =>
  new AppError('UPLOAD_NOT_FOUND', 'The uploaded file was not found. Please upload it again.');

/** Storage is essential for PDFs, so an outage is a 503, not a 500. */
async function callStorage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new ServiceUnavailableError('File storage is unavailable. Please try again shortly.', {
      cause: error,
    });
  }
}

export function createSourcesService(
  repository: SourcesRepository,
  storage: StorageProvider,
  jobs: JobsProvider,
  logger: Logger,
) {
  async function toNewSource(userId: string, input: CreateSourceInput): Promise<NewSource> {
    switch (input.type) {
      case 'WEBSITE': {
        const normalized = normalizeUrl(input.url);
        return {
          type: 'WEBSITE',
          title: websitePlaceholderTitle(input.url, SOURCE_TITLE_MAX),
          url: input.url,
          contentHash: sha256Hex(normalized),
        };
      }
      case 'YOUTUBE': {
        const videoId = parseYouTubeVideoId(input.url);
        if (!videoId) throw new ValidationError({ url: 'Must be a YouTube video URL' });
        const url = canonicalYouTubeUrl(videoId);
        return {
          type: 'YOUTUBE',
          title: youtubePlaceholderTitle(videoId),
          url,
          contentHash: sha256Hex(url),
          metadata: { videoId },
        };
      }
      case 'TEXT': {
        const content = normalizeText(input.content);
        if (content.length > quotas.textMaxChars) {
          throw new AppError(
            'QUOTA_EXCEEDED',
            `Pasted text can be at most ${quotas.textMaxChars.toLocaleString('en-US')} characters.`,
          );
        }
        return {
          type: 'TEXT',
          title: input.title,
          extractedText: content,
          contentHash: sha256Hex(content),
        };
      }
      case 'PDF': {
        if (!isOwnUploadKey(userId, input.storageKey)) throw uploadNotFound();
        const stored = await callStorage(() => storage.head(input.storageKey));
        if (!stored) throw uploadNotFound();
        // The signed upload URL binds the declared size; this guards anything else in the bucket.
        assertPdfSize(stored.size);
        return {
          type: 'PDF',
          title: input.title,
          storageKey: input.storageKey,
          // Re-verified against the file by the ingestion job.
          contentHash: input.contentHash,
          metadata: { fileSize: stored.size },
        };
      }
    }
  }

  return {
    async list(userId: string, notebookId: string): Promise<SourceList> {
      const rows = await repository.listByNotebook(userId, notebookId);
      if (!rows) throw notebookNotFound();
      return { items: rows.map(toSource), nextCursor: null };
    },

    async get(userId: string, sourceId: string): Promise<Source> {
      const row = await repository.findById(userId, sourceId);
      if (!row) throw sourceNotFound();
      return toSource(row);
    },

    /** The extracted text, for the viewer. Null until the source has been read. */
    async content(userId: string, sourceId: string): Promise<SourceContent> {
      const row = await repository.findContent(userId, sourceId);
      if (!row) throw sourceNotFound();
      return { content: row.extractedText };
    },

    async chunks(
      userId: string,
      sourceId: string,
      limit: number,
      rawCursor?: string,
    ): Promise<SourceChunkList> {
      const afterIndex = rawCursor === undefined ? undefined : decodeIndexCursor(rawCursor);
      const rows = await repository.listChunks(userId, sourceId, limit, afterIndex);
      if (!rows) throw sourceNotFound();

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeIndexCursor(last.chunkIndex) : null,
      };
    },

    /**
     * Queues a `READY` or `FAILED` source for processing again. As with `create`, a failed send
     * still returns the source: it is `PENDING`, and the sweeper sends the event again.
     */
    async reprocess(userId: string, sourceId: string): Promise<Source> {
      const result = await repository.requestReprocess(userId, sourceId);
      switch (result.kind) {
        case 'not_found':
          throw sourceNotFound();
        case 'already_processing':
          throw new AppError('ALREADY_PROCESSING', 'This source is already being processed.');
        case 'queued': {
          try {
            await jobs.send('source/reprocess', { sourceId, userId });
          } catch (err) {
            logger.warn({ err, sourceId }, 'source/reprocess not sent: source left PENDING');
          }
          return toSource(result.row);
        }
      }
    },

    async rename(userId: string, sourceId: string, title: string): Promise<Source> {
      const row = await repository.updateTitle(userId, sourceId, title);
      if (!row) throw sourceNotFound();
      return toSource(row);
    },

    /**
     * Deletes the row first, so the source leaves search immediately. The R2 file is cleaned up
     * afterwards; if that fails the file is an orphan, logged for the cleanup job (post-launch).
     */
    async delete(userId: string, sourceId: string): Promise<void> {
      const deleted = await repository.delete(userId, sourceId);
      if (!deleted) throw sourceNotFound();
      const { storageKey } = deleted;
      if (storageKey === null) return;
      try {
        await storage.delete(storageKey);
      } catch (err) {
        logger.warn({ err, storageKey, sourceId }, 'orphaned upload: R2 delete failed');
      }
    },

    /** Signed GET URL for the PDF viewer. Sources without a file (non-PDF) are a 404. */
    async fileUrl(userId: string, sourceId: string): Promise<FileUrlResponse> {
      const row = await repository.findById(userId, sourceId);
      if (!row) throw sourceNotFound();
      const { storageKey } = row;
      if (storageKey === null) throw new NotFoundError('This source has no file.');

      const expiresInSeconds = uploads.downloadUrlTtlSeconds;
      const url = await callStorage(() =>
        storage.createDownloadUrl({ key: storageKey, expiresInSeconds }),
      );
      return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
    },

    /** Checks the file and quota, then returns a signed URL for the browser to PUT the PDF to. */
    async createUpload(
      userId: string,
      notebookId: string,
      input: CreateUploadInput,
    ): Promise<UploadResponse> {
      const sourceCount = await repository.countInNotebook(userId, notebookId);
      if (sourceCount === undefined) throw notebookNotFound();
      assertUploadAllowed(input);
      if (sourceCount >= quotas.sourcesPerNotebook) throw quotaExceeded();

      const storageKey = newUploadKey(userId);
      const expiresInSeconds = uploads.uploadUrlTtlSeconds;
      const uploadUrl = await callStorage(() =>
        storage.createUploadUrl({
          key: storageKey,
          contentType: uploads.pdfContentType,
          contentLength: input.fileSize,
          expiresInSeconds,
        }),
      );
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
      return { uploadUrl, storageKey, expiresAt };
    },

    /**
     * Saves the source as `PENDING`, then sends `source/created` to start processing. The row is
     * already committed by then, so a failed send still returns the source: failing the request
     * would make a retry hit `DUPLICATE_SOURCE`. It stays `PENDING` until the sweeper sends the
     * event again.
     */
    async create(userId: string, notebookId: string, input: CreateSourceInput): Promise<Source> {
      // Ownership first, so another user's notebook is a 404 before any upload-key checks.
      if (!(await repository.ownsNotebook(userId, notebookId))) throw notebookNotFound();
      const values = await toNewSource(userId, input);
      const result = await repository.createWithinQuota(
        userId,
        notebookId,
        values,
        quotas.sourcesPerNotebook,
      );

      switch (result.kind) {
        case 'created': {
          const sourceId = result.row.id;
          try {
            await jobs.send('source/created', { sourceId, userId });
          } catch (err) {
            logger.warn({ err, sourceId }, 'source/created not sent: source left PENDING');
          }
          return toSource(result.row);
        }
        case 'duplicate':
          throw new AppError('DUPLICATE_SOURCE', 'This source is already in the notebook.', {
            existingSourceId: result.existingId,
          });
        case 'quota':
          throw quotaExceeded();
        case 'upload_used':
          throw new AppError(
            'UPLOAD_NOT_FOUND',
            'This upload was already added as a source. Please upload the file again.',
          );
        case 'notebook_not_found':
          throw notebookNotFound();
      }
    },
  };
}

export type SourcesService = ReturnType<typeof createSourcesService>;
