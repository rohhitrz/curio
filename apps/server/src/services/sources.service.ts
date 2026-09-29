import type { CreateSourceInput, CreateUploadInput, Source, UploadResponse } from '@curio/shared';
import { SOURCE_TITLE_MAX } from '@curio/shared';
import { quotas, uploads } from '../config/index.js';
import {
  AppError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../errors/app-error.js';
import type { StorageProvider } from '../lib/storage/index.js';
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
} from './source-identity.js';
import { assertUploadAllowed, isOwnUploadKey, newUploadKey } from './upload-rules.js';

function toSource(row: SourceRow): Source {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

const notebookNotFound = () => new NotFoundError('Notebook not found.');

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

/** Until the ingestion job reads the real title, a URL source is titled by its address. */
function titleFromUrl(normalized: string): string {
  return normalized.replace(/^https?:\/\//, '').slice(0, SOURCE_TITLE_MAX);
}

export function createSourcesService(repository: SourcesRepository, storage: StorageProvider) {
  async function toNewSource(userId: string, input: CreateSourceInput): Promise<NewSource> {
    switch (input.type) {
      case 'WEBSITE': {
        const normalized = normalizeUrl(input.url);
        return {
          type: 'WEBSITE',
          title: titleFromUrl(normalized),
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
          title: `YouTube video ${videoId}`,
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

    /** Saves the source as `PENDING`. Processing starts in Phase 3 (`source/created`). */
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
        case 'created':
          return toSource(result.row);
        case 'duplicate':
          throw new AppError('DUPLICATE_SOURCE', 'This source is already in the notebook.', {
            existingSourceId: result.existingId,
          });
        case 'quota':
          throw quotaExceeded();
        case 'notebook_not_found':
          throw notebookNotFound();
      }
    },
  };
}

export type SourcesService = ReturnType<typeof createSourcesService>;
