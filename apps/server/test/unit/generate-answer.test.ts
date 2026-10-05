import { citationSnapshotsSchema } from '@curio/shared';
import { describe, expect, it } from 'vitest';
import { createFakeLlm } from '../fakes/llm.js';
import {
  citedMarkers,
  removeInvalidMarkers,
  stripMarkers,
  toCitationSnapshots,
} from '../../src/pipelines/retrieval/citations.js';
import { buildContext, locationLabel } from '../../src/pipelines/retrieval/context.js';
import { generateAnswer } from '../../src/pipelines/retrieval/generate.js';
import {
  buildChatMessages,
  CHAT_ANSWER_INSTRUCTIONS,
  CHAT_REPLY_INSTRUCTIONS,
  NOT_IN_SOURCES_ANSWER,
} from '../../src/pipelines/retrieval/prompt.js';
import type { RetrievedChunk } from '../../src/pipelines/retrieval/retrieve.js';

/** One token per word. */
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

let nextId = 0;
function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  nextId += 1;
  return {
    rank: nextId,
    chunkId: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    sourceId: '11111111-1111-4111-8111-111111111111',
    sourceTitle: 'ML Notes',
    sourceType: 'PDF',
    chunkIndex: nextId,
    content: `Chunk ${nextId} text.`,
    contextHeader: 'ML Notes',
    location: {
      pageNumber: 3,
      startSeconds: null,
      endSeconds: null,
      headingPath: null,
      charStart: 10,
      charEnd: 40,
    },
    score: 0.8,
    ...overrides,
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const part of stream) text += part;
  return text;
}

describe('buildContext', () => {
  it('numbers chunks in order with title, location and text', () => {
    const a = chunk({ content: 'Dropout drops units.' });
    const b = chunk({
      sourceTitle: 'Lecture',
      sourceType: 'YOUTUBE',
      content: 'Weight decay penalizes weights.',
      location: { ...a.location, pageNumber: null, startSeconds: 3725, endSeconds: 3790 },
    });

    const context = buildContext([a, b], { maxTokens: 1000, countTokens: countWords });

    expect(context.sources.map((s) => [s.marker, s.chunk.chunkId])).toEqual([
      [1, a.chunkId],
      [2, b.chunkId],
    ]);
    expect(context.text).toBe(
      '[1] ML Notes (page 3)\nDropout drops units.\n\n[2] Lecture (at 1:02:05)\nWeight decay penalizes weights.',
    );
  });

  it('skips a chunk seen before, without leaving a gap in the numbers', () => {
    const a = chunk();
    const b = chunk();

    const context = buildContext([a, a, b], { maxTokens: 1000, countTokens: countWords });

    expect(context.sources.map((s) => [s.marker, s.chunk.chunkId])).toEqual([
      [1, a.chunkId],
      [2, b.chunkId],
    ]);
  });

  it('stops before the token budget is passed, but always keeps the best chunk', () => {
    const long = chunk({ content: Array.from({ length: 50 }, () => 'word').join(' ') });
    const short = chunk({ content: 'short' });

    expect(buildContext([long, short], { maxTokens: 10, countTokens: countWords }).sources).toEqual(
      [{ marker: 1, chunk: long }],
    );
    expect(
      buildContext([short, long], { maxTokens: 20, countTokens: countWords }).sources,
    ).toHaveLength(1);
  });

  it('labels the location per source type', () => {
    const base = chunk();
    const at = (location: Partial<RetrievedChunk['location']>) =>
      locationLabel({
        ...base,
        location: {
          pageNumber: null,
          startSeconds: null,
          endSeconds: null,
          headingPath: null,
          charStart: null,
          charEnd: null,
          ...location,
        },
      });

    expect(at({ pageNumber: 12 })).toBe('page 12');
    expect(at({ startSeconds: 65 })).toBe('at 1:05');
    expect(at({ headingPath: 'Optimizers › Adam' })).toBe('Optimizers › Adam');
    expect(at({})).toBeNull();
  });
});

describe('citations', () => {
  it('citation check: invalid [n] removed, also inside a group; valid and repeated ones kept', () => {
    const valid = new Set([1, 2]);
    expect(removeInvalidMarkers('A [1]. B [9]. C [1, 9, 2]. D [1][1]. E [9][2].', valid)).toEqual({
      text: 'A [1]. B. C [1, 2]. D [1][1]. E [2].',
      removed: [9],
    });
    expect(removeInvalidMarkers('No markers here.', valid)).toEqual({
      text: 'No markers here.',
      removed: [],
    });
    expect(removeInvalidMarkers('Thanks [1]!', new Set())).toEqual({
      text: 'Thanks!',
      removed: [1],
    });
  });

  it('reads markers in order of first appearance, including grouped ones', () => {
    expect(citedMarkers('A [2]. B [1, 3]. C [2][4]. D [1,5].')).toEqual([2, 1, 3, 4, 5]);
    expect(citedMarkers('No citations, a list [a] and [0].')).toEqual([]);
  });

  it('strips markers from old answers', () => {
    expect(stripMarkers('Dropout helps [1]. It is simple [2, 3].')).toBe(
      'Dropout helps. It is simple.',
    );
  });

  it('turns each cited marker into a snapshot with the location to open', () => {
    const pdf = chunk({ content: 'Regularization adds a penalty term to the loss.' });
    const video = chunk({
      sourceId: '22222222-2222-4222-8222-222222222222',
      sourceTitle: 'Lecture',
      sourceType: 'YOUTUBE',
      location: {
        pageNumber: null,
        startSeconds: 125,
        endSeconds: 160,
        headingPath: null,
        charStart: 0,
        charEnd: 90,
      },
    });
    const { sources } = buildContext([pdf, video], { maxTokens: 1000, countTokens: countWords });

    const snapshots = toCitationSnapshots(
      'Penalty [1]. Shown in the video [2]. Again [1].',
      sources,
      {
        snippetMaxChars: 300,
      },
    );

    expect(snapshots).toEqual([
      {
        marker: 1,
        sourceId: pdf.sourceId,
        sourceTitle: 'ML Notes',
        sourceType: 'PDF',
        snippet: 'Regularization adds a penalty term to the loss.',
        pageNumber: 3,
        startSeconds: null,
        headingPath: null,
        charStart: 10,
        charEnd: 40,
      },
      expect.objectContaining({ marker: 2, sourceType: 'YOUTUBE', startSeconds: 125 }),
    ]);
    expect(citationSnapshotsSchema.safeParse(snapshots).success).toBe(true);
  });

  it('gives no snapshot to a marker that matches no source', () => {
    const { sources } = buildContext([chunk()], { maxTokens: 1000, countTokens: countWords });

    expect(
      toCitationSnapshots('Real [1]. Invented [7].', sources, { snippetMaxChars: 300 }).map(
        (s) => s.marker,
      ),
    ).toEqual([1]);
  });

  it('cuts a long snippet at a word boundary', () => {
    const { sources } = buildContext([chunk({ content: 'alpha beta gamma delta epsilon zeta' })], {
      maxTokens: 1000,
      countTokens: countWords,
    });

    const [snapshot] = toCitationSnapshots('[1]', sources, { snippetMaxChars: 20 });

    expect(snapshot?.snippet).toBe('alpha beta gamma…');
  });
});

describe('buildChatMessages', () => {
  it('puts summary and history before the sources and the question, last', () => {
    const messages = buildChatMessages({
      question: 'And its downside?',
      contextText: '[1] ML Notes (page 3)\nDropout drops units.',
      summary: 'We talked about overfitting.',
      history: [
        { role: 'user', content: 'What is dropout?' },
        { role: 'assistant', content: 'It drops units [1].' },
      ],
    });

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages[0]?.content).toContain('We talked about overfitting.');
    expect(messages[3]?.content).toBe('It drops units.');
    expect(messages.at(-1)?.content).toBe(
      '<sources>\n[1] ML Notes (page 3)\nDropout drops units.\n</sources>\n\nQuestion: And its downside?',
    );
  });

  it('the instructions hold no request data and name the refusal sentence', () => {
    expect(CHAT_ANSWER_INSTRUCTIONS).toContain(NOT_IN_SOURCES_ANSWER);
    expect(CHAT_ANSWER_INSTRUCTIONS).not.toMatch(/\$\{|Question:/);
  });
});

describe('generateAnswer', () => {
  it('a message routed past retrieval gets a short reply: chatReply task, no sources', async () => {
    const llm = createFakeLlm('You are welcome!');

    const answer = generateAnswer(
      {
        question: 'thanks!',
        chunks: [],
        history: [{ role: 'assistant', content: 'Dropout drops units [1].' }],
        retrieved: false,
      },
      { llm: llm.provider, countTokens: countWords },
    );

    expect(await drain(answer.textStream)).toBe('You are welcome!');
    expect(await answer.result).toMatchObject({
      text: 'You are welcome!',
      citations: [],
      refused: false,
      model: 'fake-llm',
    });
    expect(answer.sources).toEqual([]);
    const [request] = llm.requests;
    expect(request?.task).toBe('chatReply');
    expect(request?.instructions).toBe(CHAT_REPLY_INSTRUCTIONS);
    expect(request?.messages).toEqual([
      { role: 'assistant', content: 'Dropout drops units.' },
      { role: 'user', content: 'thanks!' },
    ]);
  });

  it('streams a grounded answer and returns its citation snapshots', async () => {
    const llm = createFakeLlm('Dropout randomly drops units during training [1].');
    const a = chunk({ content: 'Dropout drops units at random.' });

    const answer = generateAnswer(
      { question: 'What is dropout?', chunks: [a], history: [] },
      { llm: llm.provider, countTokens: countWords },
    );

    expect(await drain(answer.textStream)).toBe(
      'Dropout randomly drops units during training [1].',
    );
    const result = await answer.result;
    expect(result).toMatchObject({ refused: false, model: 'fake-llm' });
    expect(result.citations.map((c) => [c.marker, c.snippet])).toEqual([
      [1, 'Dropout drops units at random.'],
    ]);
    expect(answer.sources).toHaveLength(1);

    const [request] = llm.requests;
    expect(request?.task).toBe('chatAnswer');
    expect(request?.instructions).toBe(CHAT_ANSWER_INSTRUCTIONS);
    expect(request?.messages.at(-1)?.content).toContain('[1] ML Notes (page 3)');
  });

  it('with no chunks it says "not in your sources" without calling the model', async () => {
    const llm = createFakeLlm();

    const answer = generateAnswer(
      { question: 'What is dropout?', chunks: [], history: [] },
      { llm: llm.provider, countTokens: countWords },
    );

    expect(await drain(answer.textStream)).toBe(NOT_IN_SOURCES_ANSWER);
    await expect(answer.result).resolves.toEqual({
      text: NOT_IN_SOURCES_ANSWER,
      removedMarkers: [],
      citations: [],
      refused: true,
      suggestComplete: false,
      model: null,
      usage: null,
    });
    expect(llm.requests).toEqual([]);
  });

  it('a refusal from the model has no citations', async () => {
    const llm = createFakeLlm(NOT_IN_SOURCES_ANSWER);

    const answer = generateAnswer(
      { question: 'Who won the 1998 World Cup?', chunks: [chunk()], history: [] },
      { llm: llm.provider, countTokens: countWords },
    );
    await drain(answer.textStream);

    await expect(answer.result).resolves.toMatchObject({ refused: true, citations: [] });
  });

  it('a failed call rejects the text stream and the result', async () => {
    const failure = new Error('model down');
    const llm = createFakeLlm(failure);

    const answer = generateAnswer(
      { question: 'What is dropout?', chunks: [chunk()], history: [] },
      { llm: llm.provider, countTokens: countWords },
    );

    await expect(drain(answer.textStream)).rejects.toBe(failure);
    await expect(answer.result).rejects.toBe(failure);
  });
});
