import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const datasetDir = fileURLToPath(new URL('../dataset/', import.meta.url));
export const cacheDir = fileURLToPath(new URL('../.cache/', import.meta.url));
export const documentsFile = `${datasetDir}documents.json`;

const base = {
  /** Stable ID used by questions' `expectedLocations`. */
  id: z.string().regex(/^doc-[a-z0-9-]+$/),
  title: z.string().min(1),
};

/**
 * One eval document. Third-party content is fetched into the gitignored cache; `sha256` is the
 * hash of the cached file, so a changed upstream page is noticed instead of silently shifting
 * the numbers.
 */
export const documentSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('PDF'), url: z.url(), sha256: z.string().optional() }),
  z.object({ ...base, type: z.literal('WEBSITE'), url: z.url(), sha256: z.string().optional() }),
  z.object({ ...base, type: z.literal('YOUTUBE'), url: z.url(), sha256: z.string().optional() }),
  /** Original notes, committed under `dataset/`. */
  z.object({ ...base, type: z.literal('TEXT'), file: z.string().min(1) }),
]);

export type EvalDocument = z.infer<typeof documentSchema>;
export type FetchedDocument = Exclude<EvalDocument, { type: 'TEXT' }>;

export async function readDocuments(): Promise<EvalDocument[]> {
  const raw: unknown = JSON.parse(await readFile(documentsFile, 'utf8'));
  const documents = z.array(documentSchema).parse(raw);
  const ids = new Set<string>();
  for (const { id } of documents) {
    if (ids.has(id)) throw new Error(`Duplicate document id ${id}`);
    ids.add(id);
  }
  return documents;
}

/** Where a fetched document is cached: the PDF itself, or the provider's result as JSON. */
export function cachePath(document: FetchedDocument): string {
  return `${cacheDir}${document.id}.${document.type === 'PDF' ? 'pdf' : 'json'}`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
