import type { LlmProvider, LlmRequest, LlmResult } from '../../src/lib/llm/index.js';

const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };

/** Splits a reply into a few stream parts, like a real stream. */
function parts(text: string): string[] {
  return text.match(/.{1,8}/gs) ?? [];
}

/**
 * An LLM without any API call: answers with the queued replies in order (an `Error` fails the
 * call; for a stream, after the first part). Every request is recorded.
 */
export function createFakeLlm(...replies: (string | Error)[]) {
  const requests: LlmRequest[] = [];
  const queue = [...replies];

  function next(request: LlmRequest): string | Error {
    requests.push(request);
    const reply = queue.shift();
    if (reply === undefined) return new Error('fake LLM: no reply left');
    return reply;
  }

  const provider: LlmProvider = {
    generate(request) {
      const reply = next(request);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ text: reply, model: 'fake-llm', usage });
    },

    stream(request) {
      const reply = next(request);
      let resolve!: (result: LlmResult) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<LlmResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      result.catch(() => undefined);

      async function* textStream(): AsyncGenerator<string> {
        // Parts arrive asynchronously, as from the network.
        await Promise.resolve();
        if (reply instanceof Error) {
          yield 'Partial';
          reject(reply);
          throw reply;
        }
        for (const part of parts(reply)) yield part;
        resolve({ text: reply, model: 'fake-llm', usage });
      }

      return { textStream: textStream(), result };
    },
  };

  return {
    provider,
    requests,
    /** Queues more replies. */
    reply: (...more: (string | Error)[]) => queue.push(...more),
  };
}

export type FakeLlm = ReturnType<typeof createFakeLlm>;
