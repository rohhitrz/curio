/** In-memory storage for tests. `put` simulates the browser upload; calls are recorded. */
export function createFakeStorage() {
  const objects = new Map();
  const contents = new Map();
  const deleted = [];
  let failNext = null;
  /** Rejects when a failure was queued, like a real provider's failed call. */
  async function maybeFail() {
    if (failNext) {
      const error = failNext;
      failNext = null;
      return Promise.reject(error);
    }
  }
  const provider = {
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
    async download(key) {
      await maybeFail();
      if (!objects.has(key)) return null;
      return contents.get(key) ?? new Uint8Array();
    },
    async delete(key) {
      await maybeFail();
      objects.delete(key);
      contents.delete(key);
      deleted.push(key);
    },
  };
  return {
    provider,
    deleted,
    put(key, size = 1024, contentType = 'application/pdf') {
      objects.set(key, { size, contentType });
    },
    /** Like `put`, with the file's bytes, for code that downloads it. */
    putFile(key, bytes, contentType = 'application/pdf') {
      objects.set(key, { size: bytes.length, contentType });
      contents.set(key, bytes);
    },
    has: (key) => objects.has(key),
    /** The next call rejects with this error (e.g. to simulate R2 being down). */
    failNextCall(error) {
      failNext = error;
    },
  };
}
//# sourceMappingURL=storage.js.map
