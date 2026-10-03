import type { Message } from '@curio/shared';
import { describe, expect, it } from 'vitest';
import { buildChatItems, isAnswerSaved } from './display';
import { emptyAnswer } from './stream';

const CONVERSATION = 'c1';

function message(seq: number, role: Message['role'], overrides: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`,
    conversationId: CONVERSATION,
    seq,
    role,
    content: role === 'USER' ? `Question ${seq}` : `Answer ${seq}`,
    citations: [],
    status: 'COMPLETE',
    feedback: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildChatItems', () => {
  it('lists saved messages in order', () => {
    const items = buildChatItems([message(1, 'USER'), message(2, 'ASSISTANT')], null, CONVERSATION);

    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ['question', 'm1'],
      ['answer', 'm2'],
    ]);
  });

  it('adds the streaming turn: question once, then the partial answer', () => {
    const pending = {
      conversationId: CONVERSATION,
      question: { id: 'm3', content: 'New?' },
      answer: { ...emptyAnswer, text: 'Part', status: null },
    };

    const items = buildChatItems(
      [message(1, 'USER'), message(2, 'ASSISTANT')],
      pending,
      CONVERSATION,
    );
    expect(items.map((i) => i.key)).toEqual(['m1', 'm2', 'm3', 'pending']);
    expect(items.at(-1)).toMatchObject({ kind: 'answer', text: 'Part', streaming: true });

    // Once the question is saved (reloaded) it isn't shown twice.
    const reloaded = buildChatItems(
      [message(1, 'USER'), message(2, 'ASSISTANT'), message(3, 'USER', { id: 'm3' })],
      pending,
      CONVERSATION,
    );
    expect(reloaded.filter((i) => i.key === 'm3')).toHaveLength(1);
  });

  it('ignores a turn streaming in another conversation', () => {
    const pending = {
      conversationId: 'other',
      question: { id: 'x', content: 'Q' },
      answer: emptyAnswer,
    };

    const saved = [message(1, 'USER'), message(2, 'ASSISTANT')];
    expect(buildChatItems(saved, pending, CONVERSATION)).toHaveLength(2);
  });

  it('a failed last answer is retryable; while retrying it is replaced by the new answer', () => {
    const messages = [
      message(1, 'USER'),
      message(2, 'ASSISTANT', { status: 'ERROR', content: '' }),
    ];

    expect(buildChatItems(messages, null, CONVERSATION).at(-1)).toMatchObject({
      error: 'This answer failed.',
      retryable: true,
    });

    const retrying = buildChatItems(
      messages,
      { conversationId: CONVERSATION, question: null, answer: emptyAnswer },
      CONVERSATION,
    );
    expect(retrying.map((i) => i.key)).toEqual(['m1', 'pending']);
  });

  it('an older failed answer is not retryable', () => {
    const items = buildChatItems(
      [
        message(1, 'USER'),
        message(2, 'ASSISTANT', { status: 'ERROR' }),
        message(3, 'USER'),
        message(4, 'ASSISTANT'),
      ],
      null,
      CONVERSATION,
    );

    expect(items[1]).toMatchObject({ error: 'This answer failed.', retryable: false });
  });

  it('a stream error stops the spinner and shows the message', () => {
    const items = buildChatItems(
      [],
      {
        conversationId: CONVERSATION,
        question: { id: 'q', content: 'Q' },
        answer: {
          ...emptyAnswer,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Please retry.' },
        },
      },
      CONVERSATION,
    );

    expect(items.at(-1)).toMatchObject({ streaming: false, error: 'Please retry.' });
  });

  it('a last question with no answer gets a failed answer that can be retried', () => {
    const items = buildChatItems(
      [message(1, 'USER'), message(2, 'ASSISTANT'), message(3, 'USER')],
      null,
      CONVERSATION,
    );

    expect(items.map((i) => i.key)).toEqual(['m1', 'm2', 'm3', 'unanswered-m3']);
    expect(items.at(-1)).toMatchObject({
      kind: 'answer',
      error: 'This question has no answer yet.',
      retryable: true,
      messageId: null,
    });
  });

  it('while a turn is pending, an unanswered question shows the turn instead', () => {
    const items = buildChatItems(
      [message(1, 'USER', { id: 'q' })],
      { conversationId: CONVERSATION, question: { id: 'q', content: 'Q' }, answer: emptyAnswer },
      CONVERSATION,
    );

    expect(items.map((i) => i.key)).toEqual(['q', 'pending']);
  });
});

describe('isAnswerSaved', () => {
  const turn = (overrides: { messageId?: string; questionId?: string | null }) => ({
    conversationId: CONVERSATION,
    question:
      overrides.questionId === null
        ? null
        : { id: overrides.questionId ?? 'm1', content: 'Question 1' },
    answer: { ...emptyAnswer, messageId: overrides.messageId ?? null },
  });

  it("finds the streamed answer's ID", () => {
    const saved = [message(1, 'USER'), message(2, 'ASSISTANT', { id: 'a' })];
    expect(isAnswerSaved(saved, turn({ messageId: 'a', questionId: null }))).toBe(true);
  });

  it('a question followed by an answer counts, even under another ID', () => {
    const saved = [message(1, 'USER'), message(2, 'ASSISTANT')];
    expect(isAnswerSaved(saved, turn({ messageId: 'other' }))).toBe(true);
  });

  it('a question still waiting, or a retry whose answer is not there, is not saved', () => {
    expect(isAnswerSaved([message(1, 'USER')], turn({}))).toBe(false);
    expect(isAnswerSaved([message(1, 'USER')], turn({ messageId: 'a', questionId: null }))).toBe(
      false,
    );
  });
});
