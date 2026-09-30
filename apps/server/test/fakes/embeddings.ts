import { createHash } from 'node:crypto';
import { embeddings } from '../../src/config/index.js';
import type { EmbeddingsProvider } from '../../src/lib/embeddings/index.js';

/** A stable unit vector per text: the same text always gets the same vector. */
export function fakeVector(text: string, dimensions: number = embeddings.dimensions): number[] {
  const bytes = createHash('sha512').update(text).digest();
  const vector = Array.from(
    { length: dimensions },
    (_, i) => (bytes[i % bytes.length] ?? 0) - 127.5,
  );
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

/** Deterministic embeddings without any API call. Every `embed` call is recorded. */
export function createFakeEmbeddings(model = 'fake-embedding-model') {
  const calls: string[][] = [];
  const failures: Error[] = [];

  const provider: EmbeddingsProvider = {
    model,
    embed(texts) {
      calls.push(texts);
      const failure = failures.shift();
      if (failure) return Promise.reject(failure);
      return Promise.resolve(texts.map((text) => fakeVector(text)));
    },
  };

  return {
    provider,
    calls,
    /** The next calls reject with these errors, one per call. */
    failNext: (...errors: Error[]) => failures.push(...errors),
  };
}

export type FakeEmbeddings = ReturnType<typeof createFakeEmbeddings>;
