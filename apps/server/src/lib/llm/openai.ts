import { createOpenAI, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import {
  APICallError,
  generateText,
  RetryError,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import type { LlmTask, LlmTaskConfig, LlmTier } from '../../config/index.js';
import { LlmError } from '../../errors/llm-error.js';
import type { LlmProvider, LlmRequest, LlmResult, LlmUsage } from './types.js';

export interface OpenAiLlmConfig {
  apiKey: string;
  models: Record<LlmTier, string>;
  tasks: Record<LlmTask, LlmTaskConfig>;
  /** Per call, including streaming. */
  timeoutMs: number;
  maxRetries: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

function toUsage(usage: LanguageModelUsage): LlmUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/** Classifies whatever the SDK threw (after its own retries) as retryable or not. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const last = RetryError.isInstance(error) ? error.lastError : error;

  if (APICallError.isInstance(last)) {
    // Out of credits is also a 429, but waiting doesn't fix it.
    const outOfCredits = last.responseBody?.includes('insufficient_quota') ?? false;
    return new LlmError(
      last.isRetryable && !outOfCredits,
      `OpenAI ${last.statusCode ?? 'error'}: ${last.message}`,
      { cause: error },
    );
  }
  // Timeouts and network failures can pass; anything else (bad response shape) won't.
  const transient =
    last instanceof Error &&
    (last.name === 'TimeoutError' || last.name === 'AbortError' || last instanceof TypeError);
  const detail = last instanceof Error ? last.message : String(last);
  return new LlmError(transient, `LLM call failed: ${detail}`, { cause: error });
}

export function createOpenAiLlm(config: OpenAiLlmConfig): LlmProvider {
  const openai = createOpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });

  function callOptions(request: LlmRequest) {
    const task = config.tasks[request.task];
    const modelId = config.models[task.tier];
    const messages: ModelMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const openaiOptions = {
      // Same key for every call of a task, so they land on the same cache (static prefix first).
      promptCacheKey: `curio:${request.task}`,
      reasoningEffort: task.reasoningEffort,
      // Questions and source text aren't kept by OpenAI; Langfuse is our record.
      store: false,
    } satisfies OpenAILanguageModelResponsesOptions;

    return {
      modelId,
      options: {
        model: openai(modelId),
        instructions: request.instructions,
        messages,
        maxOutputTokens: task.maxOutputTokens,
        maxRetries: config.maxRetries,
        timeout: config.timeoutMs,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        providerOptions: { openai: openaiOptions },
        // Named after the task in Langfuse (when a tracer is registered).
        telemetry: { functionId: request.task },
      },
    };
  }

  return {
    async generate(request) {
      const { modelId, options } = callOptions(request);
      try {
        const result = await generateText(options);
        return { text: result.text, model: modelId, usage: toUsage(result.usage) };
      } catch (error) {
        throw toLlmError(error);
      }
    },

    stream(request) {
      const { modelId, options } = callOptions(request);
      let failure: LlmError | undefined;
      const call = streamText({
        ...options,
        onError: ({ error }) => {
          failure ??= toLlmError(error);
        },
      });

      async function* textStream(): AsyncGenerator<string> {
        for await (const part of call.stream) {
          if (part.type === 'text-delta') yield part.text;
          else if (part.type === 'error') throw (failure ??= toLlmError(part.error));
        }
        if (failure) throw failure;
      }

      const result: Promise<LlmResult> = Promise.all([call.text, call.usage]).then(
        ([text, usage]) => {
          if (failure) throw failure;
          return { text, model: modelId, usage: toUsage(usage) };
        },
        (error: unknown) => {
          throw failure ?? toLlmError(error);
        },
      );
      // A caller that stops at the text stream must not crash the process with an unhandled
      // rejection; callers that await `result` still see the error.
      result.catch(() => undefined);

      return { textStream: textStream(), result };
    },
  };
}
