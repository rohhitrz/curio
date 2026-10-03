import type { Logger } from 'pino';
import { ServiceUnavailableError } from '../errors/app-error.js';
import type { EmbeddingsProvider } from '../lib/embeddings/index.js';
import type { TopicRow, TopicsRepository } from '../repositories/topics.repository.js';

/**
 * The key two wordings of one topic share: Unicode-normalized, lower case, single spaces.
 * Only spelling variants meet here; synonyms ("ML" / "Machine Learning") stay separate topics,
 * related later by embedding similarity, never merged (decision DB-06).
 */
export function normalizeTopicName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Topics are shared and each one is embedded once, when first seen (docs/03-database-design.md §7). */
export function createTopicsService(deps: {
  repository: TopicsRepository;
  embeddings: EmbeddingsProvider;
  logger: Logger;
}) {
  const { repository, embeddings, logger } = deps;

  return {
    /** The topic for `name`, created (and embedded) if it's new. Embeddings down → 503. */
    async findOrCreate(name: string): Promise<TopicRow> {
      const normalizedName = normalizeTopicName(name);
      const existing = await repository.findByNormalizedName(normalizedName);
      if (existing) return existing;

      let embedding: number[] | undefined;
      try {
        [embedding] = await embeddings.embed([name]);
      } catch (err) {
        logger.warn({ err, topic: normalizedName }, 'topic not embedded');
        throw new ServiceUnavailableError(undefined, { cause: err });
      }
      if (!embedding) throw new Error('embeddings returned no vector for the topic');
      return repository.insertOrGet({ name, normalizedName, embedding });
    },
  };
}

export type TopicsService = ReturnType<typeof createTopicsService>;
