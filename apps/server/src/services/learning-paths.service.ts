import type { PrefillResponse } from '@curio/shared';
import type { Logger } from 'pino';
import { learningPaths as learningPathsConfig } from '../config/index.js';
import type { EmbeddingsProvider } from '../lib/embeddings/index.js';
import type { MemoriesRepository } from '../repositories/memories.repository.js';
import type { TopicsRepository } from '../repositories/topics.repository.js';
import { normalizeTopicName } from './topics.service.js';

export function createLearningPathsService(deps: {
  topics: TopicsRepository;
  memories: MemoriesRepository;
  embeddings: EmbeddingsProvider;
  logger: Logger;
}) {
  const { topics, memories, embeddings, logger } = deps;

  return {
    /**
     * The level to pre-fill on the clarify screen: the one confirmed for this topic, else the
     * one of the most similar topic studied. Read-only: an unseen topic is embedded but not
     * created. Pre-fill is a convenience, so embeddings down → no match (the learner just picks).
     */
    async prefill(userId: string, topicName: string): Promise<PrefillResponse> {
      const levels = await memories.levels(userId);
      if (levels.length === 0) return { match: null };

      const topic = await topics.findWithEmbedding(normalizeTopicName(topicName));
      const exact = topic && levels.find((l) => l.topicId === topic.id);
      if (exact)
        return { match: { type: 'EXACT', topicName: exact.topicName, level: exact.level } };

      let embedding = topic?.embedding;
      if (!embedding) {
        try {
          [embedding] = await embeddings.embed([topicName]);
        } catch (err) {
          logger.warn({ err }, 'prefill: topic not embedded; no match offered');
          return { match: null };
        }
      }
      if (!embedding) return { match: null };

      const related = await memories.nearestLevel(userId, embedding, {
        minSimilarity: learningPathsConfig.relatedTopicMinSimilarity,
        ...(topic ? { excludeTopicId: topic.id } : {}),
      });
      return related
        ? { match: { type: 'RELATED', topicName: related.topicName, level: related.level } }
        : { match: null };
    },
  };
}

export type LearningPathsService = ReturnType<typeof createLearningPathsService>;
