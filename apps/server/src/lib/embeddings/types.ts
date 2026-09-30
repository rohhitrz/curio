/**
 * Turns text into vectors. Failures are `IngestionError`s, already classified transient or
 * permanent.
 */
export interface EmbeddingsProvider {
  /** Stored with each source, so a model switch shows which sources need re-embedding. */
  readonly model: string;
  /** One vector per text, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
}
