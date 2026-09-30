import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

/** Token count as OpenAI's embedding models see it (`cl100k_base`, used by `text-embedding-3-*`). */
export function countTokens(text: string): number {
  return countCl100k(text);
}
