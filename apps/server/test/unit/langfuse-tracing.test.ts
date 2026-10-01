import { tracing as otel } from '@opentelemetry/sdk-node';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { llmModels, llmTasks } from '../../src/config/index.js';
import { createOpenAiLlm } from '../../src/lib/llm/index.js';
import { startLangfuseTracing } from '../../src/lib/tracing/index.js';
import { json, stubFetch } from '../helpers/fetch.js';

const MAX_CHARS = 20;
const exporter = new otel.InMemorySpanExporter();
const create = vi.fn();
const flush = vi.fn(() => Promise.resolve());
const scores = { create, flush };
// Spans are captured in memory and scores by the stub: nothing reaches Langfuse.
const { tracer, shutdown } = startLangfuseTracing({
  publicKey: 'pk-lf-test',
  secretKey: 'sk-lf-test',
  baseUrl: 'http://127.0.0.1:1',
  environment: 'test',
  maxTextChars: MAX_CHARS,
  exportMode: 'immediate',
  exporter,
  scores,
});

const responseBody = {
  id: 'resp_1',
  object: 'response',
  created_at: 1_790_000_000,
  model: 'gpt-6-luna',
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Answer [1].', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1205,
  },
};

function llm() {
  return createOpenAiLlm({
    apiKey: 'sk-test',
    models: llmModels,
    tasks: llmTasks,
    timeoutMs: 5_000,
    maxRetries: 0,
    fetch: stubFetch(json(responseBody)).fetch,
  });
}

async function exported() {
  await tracer.flush();
  return exporter.getFinishedSpans();
}

const byName = (spans: otel.ReadableSpan[], name: string) => {
  const span = spans.find((s) => s.name === name);
  if (!span) throw new Error(`no span "${name}" in ${spans.map((s) => s.name).join(', ')}`);
  return span;
};

beforeEach(() => {
  exporter.reset();
  vi.clearAllMocks();
});

afterAll(async () => {
  await shutdown();
});

describe('Langfuse tracing', () => {
  it('puts the steps and the LLM call of a request in one trace, with user and session', async () => {
    let traceId = '';
    await tracer.trace({ name: 'chat', userId: 'user-1', sessionId: 'conv-1' }, async (trace) => {
      traceId = trace.traceId;
      await tracer.span(
        'search',
        { query: 'dropout' },
        () => Promise.resolve([{ chunkId: 'c1', score: 0.9, content: 'long chunk text' }]),
        (chunks) => chunks.map(({ chunkId, score }) => ({ chunkId, score })),
      );
      await llm().generate({
        task: 'chatAnswer',
        instructions: 'Answer from the sources.',
        messages: [{ role: 'user', content: 'What is dropout?' }],
      });
      trace.setOutput('Answer [1].');
    });

    const spans = await exported();
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));
    for (const span of spans) {
      expect(span.attributes['user.id']).toBe('user-1');
      expect(span.attributes['session.id']).toBe('conv-1');
      expect(span.attributes['langfuse.trace.name']).toBe('chat');
    }

    const search = byName(spans, 'search');
    expect(search.attributes['langfuse.observation.input']).toBe('{"query":"dropout"}');
    // The output picker keeps chunk text out of the span.
    expect(search.attributes['langfuse.observation.output']).toBe('[{"chunkId":"c1","score":0.9}]');

    const generation = spans.find((s) => s.attributes['gen_ai.operation.name'] === 'chat');
    expect(generation?.attributes).toMatchObject({
      'gen_ai.request.model': 'gpt-6-luna',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.cache_read.input_tokens': 1024,
      'gen_ai.usage.output_tokens': 5,
    });
    const root = spans.find((s) => s.attributes['langfuse.internal.is_app_root'] === true);
    expect(root?.attributes['langfuse.observation.output']).toBe('Answer [1].');
  });

  it('a streamed LLM call is recorded in the trace too', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-6-luna' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'Hi',
      },
      { type: 'response.completed', response: responseBody },
    ];
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const provider = createOpenAiLlm({
      apiKey: 'sk-test',
      models: llmModels,
      tasks: llmTasks,
      timeoutMs: 5_000,
      maxRetries: 0,
      fetch: stubFetch(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
        .fetch,
    });

    await tracer.trace({ name: 'chat', userId: 'user-1' }, async () => {
      const stream = provider.stream({
        task: 'chatAnswer',
        instructions: 'Answer from the sources.',
        messages: [{ role: 'user', content: 'hello' }],
      });
      for await (const part of stream.textStream) expect(part).toBe('Hi');
      await stream.result;
    });

    const spans = await exported();
    const generation = spans.find((s) => s.attributes['gen_ai.operation.name'] === 'chat');
    expect(generation?.attributes['gen_ai.usage.output_tokens']).toBe(5);
  });

  it('cuts long text everywhere, including the prompt the AI SDK records', async () => {
    const chunk = 'x'.repeat(200);
    await tracer.trace({ name: 'chat', userId: 'user-1', input: { question: chunk } }, () =>
      llm().generate({
        task: 'chatAnswer',
        instructions: 'Answer from the sources.',
        messages: [{ role: 'user', content: chunk }],
      }),
    );

    const spans = await exported();
    for (const span of spans) {
      for (const value of Object.values(span.attributes)) {
        if (typeof value === 'string') expect(value).not.toContain('x'.repeat(MAX_CHARS + 1));
      }
    }
    const root = spans.find((s) => s.attributes['langfuse.internal.is_app_root'] === true);
    expect(root?.attributes['langfuse.observation.input']).toContain('[180 more chars]');
  });

  it('a failing step is marked as an error and the error still reaches the caller', async () => {
    const failure = new Error('rerank down');

    const error = await tracer
      .trace({ name: 'chat', userId: 'user-1' }, () =>
        tracer.span('rerank', {}, () => Promise.reject(failure)),
      )
      .catch((e: unknown) => e);

    expect(error).toBe(failure);
    const spans = await exported();
    expect(byName(spans, 'rerank').attributes).toMatchObject({
      'langfuse.observation.level': 'ERROR',
      'langfuse.observation.status_message': 'rerank down',
    });
  });

  it('sends a score with a stable id, and waits until it is sent', async () => {
    await tracer.score({ id: 'feedback-msg-1', traceId: 'trace-1', name: 'feedback', value: 1 });

    expect(create).toHaveBeenCalledWith({
      id: 'feedback-msg-1',
      traceId: 'trace-1',
      name: 'feedback',
      value: 1,
    });
    expect(flush).toHaveBeenCalled();
  });
});
