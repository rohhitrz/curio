import type { StorageProvider, StoredObject } from '../../src/lib/storage/index.js';

/** In-memory storage for tests. `put` simulates the browser upload; calls are recorded. */
export function createFakeStorage() {
  const objects = new Map<string, StoredObject>();
  const deleted: string[] = [];
  let failNext: Error | null = null;

  /** Rejects when a failure was queued, like a real provider's failed call. */
  async function maybeFail(): Promise<void> {
    if (failNext) {
      const error = failNext;
      failNext = null;
      return Promise.reject(error);
    }
  }

  const provider: StorageProvider = {
    async createUploadUrl({ key, contentType, contentLength, expiresInSeconds }) {
      await maybeFail();
      const params = new URLSearchParams({
        op: 'put',
        type: contentType,
        length: String(contentLength),
        ttl: String(expiresInSeconds),
      });
      return `https://fake-storage.test/${key}?${params.toString()}`;
    },
    async createDownloadUrl({ key, expiresInSeconds }) {
      await maybeFail();
      return `https://fake-storage.test/${key}?op=get&ttl=${expiresInSeconds}`;
    },
    async head(key) {
      await maybeFail();
      return objects.get(key) ?? null;
    },
    async delete(key) {
      await maybeFail();
      objects.delete(key);
      deleted.push(key);
    },
  };

  return {
    provider,
    deleted,
    put(key: string, size = 1024, contentType = 'application/pdf') {
      objects.set(key, { size, contentType });
    },
    has: (key: string) => objects.has(key),
    /** The next call rejects with this error (e.g. to simulate R2 being down). */
    failNextCall(error: Error) {
      failNext = error;
    },
  };
}

export type FakeStorage = ReturnType<typeof createFakeStorage>;
