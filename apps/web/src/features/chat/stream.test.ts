import type { UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { applyChunk, emptyAnswer, readChatStream, type AnswerState } from './stream';

const citation = {
  marker: 1,
  sourceId: '11111111-1111-4111-8111-111111111111',
  sourceTitle: 'ML Notes',
  sourceType: 'PDF' as const,
  snippet: 'Dropout drops units.',
  pageNumber: 4,
  startSeconds: null,
  headingPath: null,
  charStart: null,
  charEnd: null,
};

const fold = (chunks: UIMessageChunk[]): AnswerState => chunks.reduce(applyChunk, emptyAnswer);

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text).body as ReadableStream<Uint8Array>;
}

describe('applyChunk', () => {
  it('builds the answer from a complete stream', () => {
    const state = fold([
      { type: 'start', messageId: 'm2' },
      { type: 'text-start', id: 't' },
      { type: 'data-status', data: { message: 'Searching your sources…' }, transient: true },
      { type: 'text-delta', id: 't', delta: 'Dropout ' },
      { type: 'text-delta', id: 't', delta: 'drops units [1].' },
      { type: 'data-citations', data: [citation] },
      { type: 'text-end', id: 't' },
      { type: 'finish', messageMetadata: { traceId: 'trace-1' } },
    ]);

    expect(state).toEqual({
      messageId: 'm2',
      text: 'Dropout drops units [1].',
      status: null,
      citations: [citation],
      error: null,
      traceId: 'trace-1',
      done: true,
    });
  });

  it('shows the status until text arrives', () => {
    const state = fold([
      { type: 'start', messageId: 'm2' },
      { type: 'data-status', data: { message: 'Writing the answer…' }, transient: true },
    ]);

    expect(state.status).toBe('Writing the answer…');
    expect(applyChunk(state, { type: 'text-delta', id: 't', delta: 'Hi' }).status).toBeNull();
  });

  it('keeps the coded error from data-error over the plain error chunk', () => {
    const state = fold([
      { type: 'start', messageId: 'm2' },
      { type: 'text-delta', id: 't', delta: 'Partial' },
      { type: 'data-error', data: { code: 'SERVICE_UNAVAILABLE', message: 'Please retry.' } },
      { type: 'error', errorText: 'Please retry.' },
      { type: 'finish' },
    ]);

    expect(state.error).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Please retry.' });
    expect(state.text).toBe('Partial');
    expect(state.done).toBe(true);
  });

  it('ignores malformed data parts', () => {
    const state = fold([{ type: 'data-citations', data: [{ marker: 'x' }] }]);

    expect(state.citations).toEqual([]);
  });
});

describe('readChatStream', () => {
  it('decodes the SSE body into chunks and stops at [DONE]', async () => {
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of readChatStream(
      sse([
        { type: 'start', messageId: 'm2' },
        { type: 'text-delta', id: 't', delta: 'Hi' },
        { type: 'finish' },
      ]),
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.type)).toEqual(['start', 'text-delta', 'finish']);
    expect(fold(chunks).text).toBe('Hi');
  });
});
