import { describe, expect, it } from 'vitest';
import { conversation } from '../../src/config/index.js';
import {
  buildSummaryMessages,
  CONVERSATION_SUMMARY_INSTRUCTIONS,
  summarizeConversation,
} from '../../src/pipelines/memory/summarize.js';
import { needsSummary } from '../../src/services/conversation-summary.service.js';
import { createFakeLlm } from '../fakes/llm.js';

describe('buildSummaryMessages', () => {
  it('sends the old summary and a transcript, without citation markers', () => {
    const [message, ...rest] = buildSummaryMessages({
      previousSummary: 'The learner asked about dropout.',
      messages: [
        { role: 'user', content: 'What is [1] weight decay?' },
        { role: 'assistant', content: 'It penalizes large weights [1][2].' },
      ],
    });

    expect(rest).toEqual([]);
    expect(message?.role).toBe('user');
    expect(message?.content).toContain('Summary so far:\nThe learner asked about dropout.');
    // The learner's own words are kept as written; only answers lose their markers.
    expect(message?.content).toContain('Learner: What is [1] weight decay?');
    expect(message?.content).toContain('Curio: It penalizes large weights.');
  });

  it('marks a missing summary as none', () => {
    const [message] = buildSummaryMessages({
      previousSummary: null,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(message?.content).toContain('Summary so far:\n(none)');
  });
});

describe('summarizeConversation', () => {
  it('one call on the summary task with the fixed instructions; trims the reply', async () => {
    const llm = createFakeLlm('  New summary.\n');

    const summary = await summarizeConversation(
      { previousSummary: null, messages: [{ role: 'user', content: 'Hi' }] },
      { llm: llm.provider },
    );

    expect(summary).toBe('New summary.');
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.task).toBe('conversationSummary');
    expect(llm.requests[0]?.instructions).toBe(CONVERSATION_SUMMARY_INSTRUCTIONS);
  });
});

describe('needsSummary', () => {
  const threshold = conversation.summarizeAfterMessages;

  it('only once more than the threshold sits outside the summary', () => {
    expect(needsSummary(threshold, 0)).toBe(false);
    expect(needsSummary(threshold + 1, 0)).toBe(true);
    expect(needsSummary(threshold + 30, 30)).toBe(false);
    expect(needsSummary(threshold + 31, 30)).toBe(true);
  });
});
