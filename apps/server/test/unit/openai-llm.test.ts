import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { llmModels, llmTasks } from '../../src/config/index.js';
import { LlmError } from '../../src/errors/llm-error.js';
import { createOpenAiLlm, type LlmRequest } from '../../src/lib/llm/index.js';
import { json, stubFetch } from '../helpers/fetch.js';

const usage = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 1024 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1230,
};

function responseBody(text: string, model = 'gpt-6-luna') {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1_790_000_000,
    model,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage,
  };
}

/** A Responses API event stream that sends `deltas` and then finishes (or not). */
function sse(deltas: string[], { complete = true } = {}): Response {
  const events: unknown[] = [
    {
      type: 'response.created',
      response: { id: 'resp_1', created_at: 1_790_000_000, model: 'gpt-6-luna' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    },
    ...deltas.map((delta) => ({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta,
    })),
  ];
  if (complete) {
    events.push(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: deltas.join(''), annotations: [] }],
        },
      },
      { type: 'response.completed', response: { ...responseBody(deltas.join('')), usage } },
    );
  } else {
    events.push({
      type: 'error',
      code: 'server_error',
      message: 'The server had an error',
      param: null,
      sequence_number: 9,
    });
  }
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function apiError(status: number, code: string) {
  return json({ error: { message: `failed: ${code}`, type: code, code, param: null } }, status);
}

function llm(...replies: Parameters<typeof stubFetch>) {
  const stub = stubFetch(...replies);
  const provider = createOpenAiLlm({
    apiKey: 'sk-test',
    models: llmModels,
    tasks: llmTasks,
    timeoutMs: 30_000,
    maxRetries: 0,
    fetch: stub.fetch,
  });
  return { provider, requests: stub.requests };
}

const INSTRUCTIONS = 'You answer only from the numbered sources.';

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  task: 'chatAnswer',
  instructions: INSTRUCTIONS,
  messages: [{ role: 'user', content: 'Sources: [1] … Question: what is dropout?' }],
  ...overrides,
});

interface ResponsesBody {
  model: string;
  input: { role: string; content: unknown }[];
  max_output_tokens: number;
  prompt_cache_key: string;
  store: boolean;
  reasoning?: { effort?: string };
}

describe('OpenAI LLM', () => {
  it('sends the static instructions first, then the messages, with the task settings', async () => {
    const { provider, requests } = llm(json(responseBody('Dropout drops units [1].')));

    const result = await provider.generate(
      request({
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'follow-up' },
        ],
      }),
    );

    expect(result).toEqual({
      text: 'Dropout drops units [1].',
      model: 'gpt-6-luna',
      usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 30 },
    });
    expect(requests[0]?.url.href).toBe('https://api.openai.com/v1/responses');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test');
    const body = requests[0]?.body as ResponsesBody;
    expect(body.model).toBe(llmModels.luna);
    expect(body.max_output_tokens).toBe(llmTasks.chatAnswer.maxOutputTokens);
    expect(body.reasoning?.effort).toBe(llmTasks.chatAnswer.reasoningEffort);
    expect(body.prompt_cache_key).toBe('curio:chatAnswer');
    expect(body.store).toBe(false);
    expect(body.input.map((item) => item.role)).toEqual([
      expect.stringMatching(/^(system|developer)$/),
      'user',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(body.input[0]?.content)).toContain(INSTRUCTIONS);
  });

  it('two calls of a task share the exact same prefix and cache key', async () => {
    const { provider, requests } = llm(json(responseBody('a')), json(responseBody('b')));

    await provider.generate(request({ messages: [{ role: 'user', content: 'one' }] }));
    await provider.generate(request({ messages: [{ role: 'user', content: 'two' }] }));

    const [first, second] = requests.map((r) => r.body as ResponsesBody);
    expect(first?.input[0]).toEqual(second?.input[0]);
    expect(first?.prompt_cache_key).toBe(second?.prompt_cache_key);
  });

  it('uses Sol for a task configured as Sol', async () => {
    // No task is on Sol today (decision O-04); the tier still routes to its model.
    const stub = stubFetch(json(responseBody('ok', 'gpt-6.1-sol')));
    const provider = createOpenAiLlm({
      apiKey: 'sk-test',
      models: llmModels,
      tasks: { ...llmTasks, evalJudge: { ...llmTasks.evalJudge, tier: 'sol' } },
      timeoutMs: 30_000,
      maxRetries: 0,
      fetch: stub.fetch,
    });
    const { requests } = stub;

    const result = await provider.generate(request({ task: 'evalJudge' }));

    expect(result.model).toBe('gpt-6.1-sol');
    expect((requests[0]?.body as ResponsesBody).model).toBe('gpt-6.1-sol');
  });

  it('generateObject asks for JSON matching the schema and returns the parsed object', async () => {
    const { provider, requests } = llm(json(responseBody('{"score":4,"reason":"Close."}')));
    const schema = z.object({ score: z.number().int(), reason: z.string() });

    const result = await provider.generateObject(request({ task: 'evalJudge' }), schema);

    expect(result.object).toEqual({ score: 4, reason: 'Close.' });
    expect(result.model).toBe(llmModels.luna);
    const body = requests[0]?.body as ResponsesBody & { text?: { format?: { type?: string } } };
    expect(body.text?.format?.type).toBe('json_schema');
  });

  it('generateObject rejects a reply that does not match the schema, as retryable', async () => {
    const { provider } = llm(json(responseBody('{"score":"high"}')));

    const error = await provider
      .generateObject(request(), z.object({ score: z.number() }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmError);
    // A new sample usually parses.
    expect((error as LlmError).retryable).toBe(true);
  });

  it('generateObject rejects garbled or cut-off JSON as retryable', async () => {
    const { provider } = llm(
      json(responseBody('{"score":5,"reason":"It correctly \u001b[0m\u001b[0m')),
    );

    const error = await provider
      .generateObject(request(), z.object({ score: z.number(), reason: z.string() }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(true);
  });

  it('streams text deltas and resolves the result with usage', async () => {
    const { provider } = llm(sse(['Drop', 'out ', 'drops units [1].']));

    const stream = provider.stream(request());
    const parts: string[] = [];
    for await (const part of stream.textStream) parts.push(part);

    expect(parts.join('')).toBe('Dropout drops units [1].');
    expect(parts.length).toBeGreaterThan(1);
    await expect(stream.result).resolves.toEqual({
      text: 'Dropout drops units [1].',
      model: 'gpt-6-luna',
      usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 30 },
    });
  });

  it('a stream that fails midway throws LlmError from the text stream and the result', async () => {
    const { provider } = llm(sse(['Partial '], { complete: false }));

    const stream = provider.stream(request());
    const parts: string[] = [];
    const error = await (async () => {
      for await (const part of stream.textStream) parts.push(part);
    })().catch((e: unknown) => e);

    expect(parts).toEqual(['Partial ']);
    expect(error).toBeInstanceOf(LlmError);
    await expect(stream.result).rejects.toBeInstanceOf(LlmError);
  });

  it('a rate limit is retryable', async () => {
    const { provider } = llm(apiError(429, 'rate_limit_exceeded'));

    const error = await provider.generate(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(true);
  });

  it('out of credits is not retryable, although it is a 429', async () => {
    const { provider } = llm(apiError(429, 'insufficient_quota'));

    const error = await provider.generate(request()).catch((e: unknown) => e);

    expect((error as LlmError).retryable).toBe(false);
  });

  it('a bad key is not retryable; a server error is', async () => {
    const auth = await llm(apiError(401, 'invalid_api_key'))
      .provider.generate(request())
      .catch((e: unknown) => e);
    const outage = await llm(apiError(503, 'server_error'))
      .provider.generate(request())
      .catch((e: unknown) => e);

    expect((auth as LlmError).retryable).toBe(false);
    expect((outage as LlmError).retryable).toBe(true);
  });

  it('a network failure is retryable', async () => {
    const { provider } = llm(new TypeError('fetch failed'));

    const error = await provider.generate(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(true);
  });
});
