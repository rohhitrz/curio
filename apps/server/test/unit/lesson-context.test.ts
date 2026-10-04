import { describe, expect, it } from 'vitest';
import { buildLessonContext } from '../../src/pipelines/lessons/context.js';
import { buildLessonMessages, GENERAL_KNOWLEDGE_NOTE } from '../../src/pipelines/lessons/prompt.js';
import { conceptQuery, lessonFlags } from '../../src/pipelines/lessons/retrieve.js';
import type { RetrievedChunk } from '../../src/pipelines/retrieval/retrieve.js';

function chunk(id: string, content = `Text ${id}`): RetrievedChunk {
  return {
    rank: 1,
    chunkId: id,
    sourceId: 's1',
    sourceTitle: 'Book',
    sourceType: 'PDF',
    chunkIndex: 0,
    content,
    contextHeader: 'Book',
    location: {
      pageNumber: 3,
      startSeconds: null,
      endSeconds: null,
      headingPath: null,
      charStart: null,
      charEnd: null,
    },
    score: 0.9,
  };
}

const concept = (name: string) => ({ id: name, name, description: `About ${name}` });
/** One token per character: easy budgets. */
const countTokens = (text: string) => text.length;

describe('buildLessonContext', () => {
  it('concepts take turns: every best passage first, then the seconds', () => {
    const context = buildLessonContext(
      [
        { concept: concept('A'), chunks: [chunk('a1'), chunk('a2')] },
        { concept: concept('B'), chunks: [chunk('b1'), chunk('b2')] },
      ],
      { maxTokens: 10_000, countTokens },
    );

    expect(context.sources.map((s) => [s.marker, s.chunk.chunkId])).toEqual([
      [1, 'a1'],
      [2, 'b1'],
      [3, 'a2'],
      [4, 'b2'],
    ]);
    expect(context.concepts.map((c) => c.markers)).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(context.text).toContain('[1] Book (page 3)\nText a1');
  });

  it('a passage found for two concepts is numbered once and listed under both', () => {
    const context = buildLessonContext(
      [
        { concept: concept('A'), chunks: [chunk('shared')] },
        { concept: concept('B'), chunks: [chunk('shared'), chunk('b2')] },
      ],
      { maxTokens: 10_000, countTokens },
    );

    expect(context.sources).toHaveLength(2);
    expect(context.concepts.map((c) => c.markers)).toEqual([[1], [1, 2]]);
  });

  it('the budget stops later rounds, never a concept’s best passage; nothing found → no markers', () => {
    const long = 'x'.repeat(100);
    const context = buildLessonContext(
      [
        { concept: concept('A'), chunks: [chunk('a1', long), chunk('a2', long)] },
        { concept: concept('B'), chunks: [chunk('b1', long)] },
        { concept: concept('C'), chunks: [] },
      ],
      { maxTokens: 150, countTokens },
    );

    expect(context.sources.map((s) => s.chunk.chunkId)).toEqual(['a1', 'b1']);
    expect(context.concepts.map((c) => c.markers)).toEqual([[1], [2], []]);
  });
});

describe('lesson prompt and retrieval', () => {
  it('marks uncovered concepts as general knowledge and lists the others’ passages', () => {
    const [message] = buildLessonMessages({
      topic: 'Deep Learning',
      level: 'BEGINNER',
      goal: 'CURIOSITY',
      module: { title: 'Basics', summary: 'The basics', why: null },
      previous: { title: 'Intro', summary: 'What it is' },
      concepts: [
        { concept: concept('A'), markers: [1, 2] },
        { concept: concept('B'), markers: [] },
      ],
      contextText: '[1] Book\nText',
    });

    expect(message?.content).toContain('1. A: About A\n   → passages [1][2]');
    expect(message?.content).toContain(
      '2. B: About B\n   → GENERAL KNOWLEDGE (not in the resources)',
    );
    expect(message?.content).toContain('Module before it: Intro: What it is');
    expect(message?.content).not.toContain('Why it matters');
    expect(GENERAL_KNOWLEDGE_NOTE).toBe('General knowledge, not in the resources.');
  });

  it('searches each concept by name and meaning, without rewrite, sub-queries or HyDE', () => {
    expect(conceptQuery(concept('Dropout'))).toBe('Dropout: About Dropout');
    expect(conceptQuery({ id: 'x', name: 'Dropout', description: ' ' })).toBe('Dropout');
    expect(
      lessonFlags({
        queryRewrite: true,
        subQueries: true,
        hybridSearch: true,
        rerank: true,
        relevanceGate: true,
        hyde: true,
      }),
    ).toEqual({
      queryRewrite: false,
      subQueries: false,
      hybridSearch: true,
      rerank: true,
      relevanceGate: true,
      hyde: false,
    });
  });
});
