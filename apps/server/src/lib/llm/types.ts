import type { z } from 'zod';
import type { LlmTask } from '../../config/index.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** Picks the model, output cap and reasoning effort from `config/models.ts`. */
  task: LlmTask;
  /**
   * The task's fixed instructions, sent first. Must be the same text on every call for the task
   * (a module constant, never built from request data), so OpenAI caches it as the prompt prefix.
   */
  instructions: string;
  /** Everything that changes per request (context, history, the question) goes after the prefix. */
  messages: LlmMessage[];
  abortSignal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  /** Input tokens served from OpenAI's prompt cache. */
  cachedInputTokens: number;
  outputTokens: number;
}

export interface LlmResult {
  text: string;
  model: string;
  usage: LlmUsage;
}

export interface LlmObjectResult<T> {
  object: T;
  model: string;
  usage: LlmUsage;
}

export interface LlmStream {
  /** Text as it arrives. Throws `LlmError` if the call fails mid-stream. */
  textStream: AsyncIterable<string>;
  /** Resolves once the stream ends; rejects with `LlmError` on failure. */
  result: Promise<LlmResult>;
}

/**
 * Text generation. Failures are `LlmError`s. Calls made inside a `Tracer` trace are recorded in it
 * as generations (model, tokens, cost, latency).
 */
export interface LlmProvider {
  generate(request: LlmRequest): Promise<LlmResult>;
  /** Structured output: the model answers in JSON matching `schema` (validated). */
  generateObject<T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmObjectResult<T>>;
  stream(request: LlmRequest): LlmStream;
}
