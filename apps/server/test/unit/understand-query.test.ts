import { describe, expect, it } from 'vitest';
import { retrieval } from '../../src/config/index.js';
import {
  buildUnderstandingMessage,
  QUERY_UNDERSTANDING_INSTRUCTIONS,
  understandQuery,
} from '../../src/pipelines/retrieval/understand.js';
import { createFakeLlm } from '../fakes/llm.js';

const reply = (object: unknown) => JSON.stringify(object);

describe('understandQuery', () => {
  it('makes one queryUnderstanding call with the fixed instructions first', async () => {
    const llm = createFakeLlm(
      reply({
        needsRetrieval: true,
        standaloneQuery: 'What are dropout’s disadvantages?',
        subQueries: [],
      }),
    );

    const result = await understandQuery(
      {
        question: 'What are its disadvantages?',
        history: [
          { role: 'user', content: 'What is dropout?' },
          { role: 'assistant', content: 'Dropout drops units at random [1].' },
        ],
      },
      { llm: llm.provider },
    );

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toMatchObject({
      task: 'queryUnderstanding',
      instructions: QUERY_UNDERSTANDING_INSTRUCTIONS,
    });
    expect(result).toMatchObject({
      needsRetrieval: true,
      standaloneQuery: 'What are dropout’s disadvantages?',
      subQueries: [],
      model: 'fake-llm',
    });
  });

  it('puts the history and question in one user message, old citation markers removed', () => {
    const message = buildUnderstandingMessage({
      question: 'And its disadvantages?',
      history: [
        { role: 'user', content: 'What is dropout?' },
        { role: 'assistant', content: 'Dropout drops units at random [1][2].' },
      ],
    });
    expect(message.role).toBe('user');
    expect(message.content).toContain('User: What is dropout?');
    expect(message.content).toContain('Assistant: Dropout drops units at random.');
    expect(message.content).not.toContain('[1]');
    expect(message.content.endsWith('Latest message: And its disadvantages?')).toBe(true);
  });

  it('keeps only the most recent history messages', () => {
    const history = Array.from({ length: retrieval.understandingHistoryMessages + 2 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${String(i)}`,
    }));
    const { content } = buildUnderstandingMessage({ question: 'q', history });
    expect(content).not.toContain('message 0\n');
    expect(content).not.toContain('message 1\n');
    expect(content).toContain(`message ${String(history.length - 1)}`);
  });

  it('says "(none)" without history', () => {
    expect(buildUnderstandingMessage({ question: 'q', history: [] }).content).toContain(
      'Recent conversation:\n(none)',
    );
  });

  it('trims queries, drops blank sub-queries and caps their number', async () => {
    const llm = createFakeLlm(
      reply({
        needsRetrieval: true,
        standaloneQuery: '  compare A and B  ',
        subQueries: [' A ', '', 'B', 'C', 'D', 'E'],
      }),
    );
    const result = await understandQuery(
      { question: 'compare', history: [] },
      { llm: llm.provider },
    );
    expect(result.standaloneQuery).toBe('compare A and B');
    expect(result.subQueries).toEqual(['A', 'B', 'C', 'D', 'E'].slice(0, retrieval.maxSubQueries));
  });

  it('rejects when the call fails or the JSON does not match', async () => {
    const failing = createFakeLlm(new Error('down'));
    await expect(
      understandQuery({ question: 'q', history: [] }, { llm: failing.provider }),
    ).rejects.toThrow('down');
    const invalid = createFakeLlm(reply({ needsRetrieval: 'yes' }));
    await expect(
      understandQuery({ question: 'q', history: [] }, { llm: invalid.provider }),
    ).rejects.toThrow();
  });
});
