import type { Logger } from 'pino';
import { SearchError } from '../../errors/search-error.js';
import type { SearchProvider } from './types.js';

/**
 * Tries `primary`; when it fails, `fallback`. Both failing → a `SearchError` that is retryable
 * if either failure was.
 */
export function withSearchFallback(
  primary: SearchProvider,
  fallback: SearchProvider,
  logger: Logger,
): SearchProvider {
  return {
    async search(request) {
      try {
        return await primary.search(request);
      } catch (primaryError) {
        logger.warn({ err: primaryError }, 'web search failed; trying the fallback');
        try {
          return await fallback.search(request);
        } catch (fallbackError) {
          const retryable = [primaryError, fallbackError].some(
            (err) => !(err instanceof SearchError) || err.retryable,
          );
          throw new SearchError(retryable, 'web search failed on both providers', {
            cause: fallbackError,
          });
        }
      }
    },
  };
}
