import type {
  CitationSnapshot,
  Conversation,
  ErrorCode,
  Message,
  Paginated,
  SendMessageInput,
} from '@curio/shared';
import type { Logger } from 'pino';
import { conversation as conversationLimits, locks } from '../config/index.js';
import { AppError, NotFoundError, ServiceUnavailableError } from '../errors/app-error.js';
import { LlmError } from '../errors/llm-error.js';
import type { JobsProvider } from '../lib/jobs/index.js';
import type { LlmMessage, LlmProvider } from '../lib/llm/index.js';
import type { Lock, LockProvider } from '../lib/locks/index.js';
import type { Tracer } from '../lib/tracing/index.js';
import {
  decodeCursor,
  decodeIndexCursor,
  encodeIndexCursor,
  toPage,
} from '../pagination/cursor.js';
import { formatLearnerProfile } from '../pipelines/memory/profile.js';
import { generateAnswer } from '../pipelines/retrieval/generate.js';
import { runRetrieval, type RetrievalPipelineDeps } from '../pipelines/retrieval/pipeline.js';
import type {
  ChatRepository,
  ConversationRow,
  MessageRow,
} from '../repositories/chat.repository.js';
import type { LessonsRepository } from '../repositories/lessons.repository.js';
import type { MemoriesRepository } from '../repositories/memories.repository.js';
import { needsSummary } from './conversation-summary.service.js';
import { needsExtraction } from './memory-extraction.service.js';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';

/** What the chat stream carries (docs/04-api-design.md §8); the controller encodes it. */
export type ChatEvent =
  | { type: 'start'; messageId: string }
  | { type: 'status'; message: string }
  | { type: 'text'; delta: string }
  | { type: 'citations'; citations: CitationSnapshot[] }
  /** Tutor only: the learner seems ready; the UI offers "Mark module done" (L-10). */
  | { type: 'action'; action: { type: 'SUGGEST_COMPLETE'; moduleId: string } }
  | { type: 'finish'; traceId: string | null }
  | { type: 'error'; code: ErrorCode; message: string };

/** Receives stream events. Must not throw: the answer is generated and saved even if no one listens. */
export type ChatSink = (event: ChatEvent) => void;

/** A send or retry that passed every check and holds the conversation lock. */
export interface ChatRun {
  /** Streams the answer into `sink` and saves it. Never rejects; releases the lock at the end. */
  run(sink: ChatSink): Promise<void>;
}

export interface ChatServiceDeps {
  repository: ChatRepository;
  /** The learner's memories, for the profile in the prompt (Phase 7). */
  memories: Pick<MemoriesRepository, 'forNotebook'>;
  /** Flags and steps; `step` is set here to trace each one. */
  retrieval: Omit<RetrievalPipelineDeps, 'step'>;
  /** A lesson's tutor chat (L-10): its link check and what the tutor knows. */
  lessons: Pick<LessonsRepository, 'inNotebook' | 'tutorContext'>;
  llm: LlmProvider;
  tracer: Tracer;
  locks: LockProvider;
  /** Queues the summary and memory jobs (Phase 7). */
  jobs: JobsProvider;
  countTokens: (text: string) => number;
  logger: Logger;
}

const status = {
  searching: 'Searching your sources…',
  writing: 'Writing the answer…',
};

const notFound = () => new NotFoundError('Conversation not found.');

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    notebookId: row.notebookId,
    lessonId: row.lessonId,
    title: row.title,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role,
    content: row.content,
    citations: row.citations,
    status: row.status,
    feedback: row.feedback,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A title from the first question: its first line, cut at a word near `maxChars`. */
export function titleFromQuestion(question: string, maxChars: number): string {
  const line = (question.split('\n').find((l) => l.trim() !== '') ?? question).trim();
  if (line.length <= maxChars) return line;
  const cut = line.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Earlier turns for the prompt: complete messages only (a failed answer has nothing to add). */
function toHistory(rows: MessageRow[]): LlmMessage[] {
  return rows
    .filter((row) => row.status === 'COMPLETE')
    .map((row) => ({ role: row.role === 'USER' ? 'user' : 'assistant', content: row.content }));
}

/** The answer's slot was taken while it was generated (see `saveAssistantMessage`). */
const answerSlotTaken = () =>
  new AppError(
    'INVALID_STATE',
    'This question was answered elsewhere in the meantime. Reload the conversation.',
  );

export function failureEvent(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof LlmError) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: "The answer couldn't be generated right now. Please retry.",
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong while answering. Please retry.' };
}

export function createChatService(deps: ChatServiceDeps) {
  const { repository, tracer, logger } = deps;

  async function ownedConversation(userId: string, conversationId: string) {
    const row = await repository.findConversation(userId, conversationId);
    if (!row) throw notFound();
    return row;
  }

  async function acquireLock(conversationId: string): Promise<Lock> {
    let lock: Lock | null;
    try {
      lock = await deps.locks.acquire(
        `conversation:${conversationId}`,
        locks.conversationTtlSeconds,
      );
    } catch (err) {
      throw new ServiceUnavailableError(undefined, { cause: err });
    }
    if (!lock) {
      throw new AppError('CONVERSATION_BUSY', 'An answer is still being written. Please wait.');
    }
    return lock;
  }

  async function release(lock: Lock, conversationId: string) {
    try {
      await lock.release();
    } catch (err) {
      // It expires on its own.
      logger.warn({ err, conversationId }, 'conversation lock not released');
    }
  }

  /**
   * Renews the lock until the returned stop is called, so a slow answer never outlives it. A lock
   * that was lost is only logged: the answer's save refuses a slot that someone else took.
   */
  function keepAlive(lock: Lock, conversationId: string): () => void {
    const timer = setInterval(() => {
      lock.extend(locks.conversationTtlSeconds).then(
        (held) => {
          if (!held) logger.warn({ conversationId }, 'conversation lock lost while answering');
        },
        (err: unknown) => {
          logger.warn({ err, conversationId }, 'conversation lock not renewed');
        },
      );
    }, locks.conversationRenewSeconds * 1000);
    return () => clearInterval(timer);
  }

  /** Runs `prepare` under the conversation lock; the lock stays held for the returned run. */
  async function underLock(
    conversationId: string,
    prepare: (lock: Lock) => Promise<ChatRun>,
  ): Promise<ChatRun> {
    const lock = await acquireLock(conversationId);
    try {
      return await prepare(lock);
    } catch (err) {
      await release(lock, conversationId);
      throw err;
    }
  }

  /**
   * Queues the summary and memory jobs once enough messages are waiting for them (API doc §5,
   * step 10). Never throws: the next answer asks again.
   */
  async function requestBackgroundJobs(
    userId: string,
    conversation: ConversationRow,
    lastSeq: number,
  ) {
    const data = { conversationId: conversation.id, userId };
    const jobs: Promise<void>[] = [];
    if (needsSummary(lastSeq, conversation.summarizedThroughSeq)) {
      jobs.push(deps.jobs.send('conversation/summarize', data));
    }
    if (needsExtraction(lastSeq, conversation.memoryExtractedThroughSeq)) {
      jobs.push(deps.jobs.send('memory/extract', data));
    }
    for (const result of await Promise.allSettled(jobs)) {
      if (result.status === 'rejected') {
        logger.warn(
          { err: result.reason, conversationId: conversation.id },
          'background job not queued',
        );
      }
    }
  }

  /** The learner profile for the prompt; null if there's none or it can't be loaded (logged). */
  async function loadProfile(userId: string, conversation: ConversationRow) {
    try {
      return formatLearnerProfile(await deps.memories.forNotebook(userId, conversation.notebookId));
    } catch (err) {
      // Memory only shapes tone: answer without it rather than fail.
      logger.warn(
        { err, conversationId: conversation.id },
        'memories not loaded; answering without',
      );
      return null;
    }
  }

  /**
   * A tutor chat's context: the lesson, its module and path, and the sources it cites. Null for
   * a normal chat, or if the lesson is gone or can't be loaded (then it answers as a normal
   * chat over the notebook, logged).
   */
  async function loadTutor(userId: string, conversation: ConversationRow) {
    if (!conversation.lessonId) return null;
    try {
      return (await deps.lessons.tutorContext(userId, conversation.lessonId)) ?? null;
    } catch (err) {
      logger.warn({ err, conversationId: conversation.id }, 'tutor context not loaded');
      return null;
    }
  }

  /** Replays a saved answer without calling the model (a resend after the answer was saved). */
  function replay(answer: MessageRow, lock: Lock): ChatRun {
    return {
      async run(sink) {
        try {
          sink({ type: 'start', messageId: answer.id });
          sink({ type: 'text', delta: answer.content });
          sink({ type: 'citations', citations: answer.citations });
          sink({ type: 'finish', traceId: answer.traceId });
        } finally {
          await release(lock, answer.conversationId);
        }
      },
    };
  }

  /** Answers `question` (the user message at `questionSeq`) and saves the answer. */
  function answer(
    userId: string,
    conversation: ConversationRow,
    question: { content: string; seq: number },
    lock: Lock,
    replacesId?: string,
  ): ChatRun {
    return {
      async run(sink) {
        const messageId = crypto.randomUUID();
        let traceId: string | null = null;
        let text = '';
        const stopKeepAlive = keepAlive(lock, conversation.id);
        sink({ type: 'start', messageId });

        try {
          await tracer.trace(
            {
              name: 'chat',
              userId,
              sessionId: conversation.id,
              input: question.content,
              metadata: { conversationId: conversation.id, notebookId: conversation.notebookId },
            },
            async (trace) => {
              traceId = trace.traceId;
              // PRD speed metric: request → first text the learner sees (gated refusals too).
              const startedAt = performance.now();
              let firstTokenMs: number | null = null;
              sink({ type: 'status', message: status.searching });

              const [history, profile, tutor] = await Promise.all([
                repository.recentMessages(
                  conversation.id,
                  question.seq,
                  conversationLimits.recentMessages,
                ),
                loadProfile(userId, conversation),
                loadTutor(userId, conversation),
              ]);
              const { chunks, retrieved } = await tracer.span(
                'retrieve',
                { query: question.content },
                () =>
                  runRetrieval(
                    {
                      userId,
                      notebookId: conversation.notebookId,
                      question: question.content,
                      history: toHistory(history),
                      // A tutor searches only what its lesson cites.
                      ...(tutor ? { sourceIds: tutor.sourceIds } : {}),
                    },
                    {
                      ...deps.retrieval,
                      step: (name, input, fn) => tracer.span(name, input, fn),
                      onStepFailed: (step, err) => {
                        logger.warn(
                          { err, step, conversationId: conversation.id },
                          'retrieval step failed; skipped',
                        );
                      },
                    },
                  ),
                (found) => ({
                  retrieved: found.retrieved,
                  queries: found.queries,
                  steps: found.steps,
                  failed: found.failed,
                  gated: found.gated,
                  chunks: found.chunks.map((c) => ({
                    chunkId: c.chunkId,
                    sourceId: c.sourceId,
                    score: c.score,
                  })),
                }),
              );

              sink({ type: 'status', message: status.writing });
              const stream = generateAnswer(
                {
                  question: question.content,
                  chunks,
                  history: toHistory(history),
                  summary: conversation.summary,
                  profile,
                  retrieved,
                  tutor,
                },
                { llm: deps.llm, countTokens: deps.countTokens },
              );
              for await (const delta of stream.textStream) {
                firstTokenMs ??= Math.round(performance.now() - startedAt);
                text += delta;
                sink({ type: 'text', delta });
              }
              const result = await stream.result;

              const title =
                conversation.title === DEFAULT_CONVERSATION_TITLE && question.seq === 1
                  ? titleFromQuestion(question.content, conversationLimits.autoTitleMaxChars)
                  : undefined;
              const saved = await repository.saveAssistantMessage({
                id: messageId,
                conversationId: conversation.id,
                content: result.text,
                citations: result.citations,
                status: 'COMPLETE',
                traceId,
                questionSeq: question.seq,
                ...(replacesId ? { replacesId } : {}),
                ...(title ? { title } : {}),
              });
              if (!saved) throw answerSlotTaken();
              trace.setOutput({
                text: result.text,
                citations: result.citations.length,
                removedMarkers: result.removedMarkers,
                firstTokenMs,
                profile: profile !== null,
                tutor: tutor
                  ? { moduleId: tutor.module.id, suggestComplete: result.suggestComplete }
                  : null,
              });
              sink({ type: 'citations', citations: result.citations });
              if (tutor && result.suggestComplete) {
                sink({
                  type: 'action',
                  action: { type: 'SUGGEST_COMPLETE', moduleId: tutor.module.id },
                });
              }
              sink({ type: 'finish', traceId });
              await requestBackgroundJobs(userId, conversation, saved.seq);
            },
          );
        } catch (err) {
          logger.error({ err, conversationId: conversation.id, traceId }, 'chat answer failed');
          try {
            // Refused when the slot is taken, like the answer itself.
            await repository.saveAssistantMessage({
              id: messageId,
              conversationId: conversation.id,
              content: text,
              citations: [],
              status: 'ERROR',
              traceId,
              questionSeq: question.seq,
              ...(replacesId ? { replacesId } : {}),
            });
          } catch (saveErr) {
            logger.error(
              { err: saveErr, conversationId: conversation.id },
              'ERROR answer not saved',
            );
          }
          sink({ type: 'error', ...failureEvent(err) });
          sink({ type: 'finish', traceId });
        } finally {
          stopKeepAlive();
          await release(lock, conversation.id);
          await tracer.flush().catch((err: unknown) => {
            logger.warn({ err }, 'trace flush failed');
          });
        }
      },
    };
  }

  return {
    async listConversations(
      userId: string,
      notebookId: string,
      limit: number,
      rawCursor?: string,
    ): Promise<Paginated<Conversation>> {
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (!(await repository.notebookExists(userId, notebookId))) {
        throw new NotFoundError('Notebook not found.');
      }
      const rows = await repository.listConversations(userId, notebookId, limit, cursor);
      const page = toPage(rows, limit, (row) => ({ t: row.cursorTimestamp, i: row.id }));
      return { items: page.items.map(toConversation), nextCursor: page.nextCursor };
    },

    async createConversation(
      userId: string,
      notebookId: string,
      lessonId?: string,
    ): Promise<Conversation> {
      if (!(await repository.notebookExists(userId, notebookId))) {
        throw new NotFoundError('Notebook not found.');
      }
      // A tutor chat: the lesson must be the user's, in this notebook.
      if (
        lessonId !== undefined &&
        !(await deps.lessons.inNotebook(userId, lessonId, notebookId))
      ) {
        throw new NotFoundError('Lesson not found.');
      }
      return toConversation(
        await repository.createConversation(
          userId,
          notebookId,
          DEFAULT_CONVERSATION_TITLE,
          lessonId,
        ),
      );
    },

    async getConversation(userId: string, conversationId: string): Promise<Conversation> {
      return toConversation(await ownedConversation(userId, conversationId));
    },

    async renameConversation(
      userId: string,
      conversationId: string,
      title: string,
    ): Promise<Conversation> {
      const row = await repository.updateConversationTitle(userId, conversationId, title);
      if (!row) throw notFound();
      return toConversation(row);
    },

    async deleteConversation(userId: string, conversationId: string): Promise<void> {
      if (!(await repository.deleteConversation(userId, conversationId))) throw notFound();
    },

    async listMessages(
      userId: string,
      conversationId: string,
      limit: number,
      rawCursor?: string,
    ): Promise<Paginated<Message>> {
      const beforeSeq = rawCursor === undefined ? undefined : decodeIndexCursor(rawCursor);
      await ownedConversation(userId, conversationId);
      const rows = await repository.listMessages(conversationId, limit, beforeSeq);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(toMessage),
        nextCursor: rows.length > limit && last ? encodeIndexCursor(last.seq) : null,
      };
    },

    /**
     * Checks and saves the user's message under the conversation lock, before anything is
     * streamed (so 404 / 409 are normal responses). A resend of the same message ID never adds a
     * second message: its saved answer is replayed, or a missing / failed answer is generated.
     */
    async send(userId: string, conversationId: string, input: SendMessageInput): Promise<ChatRun> {
      const conversation = await ownedConversation(userId, conversationId);
      return underLock(conversation.id, async (lock) => {
        const { message, inserted } = await repository.insertUserMessage(
          conversation.id,
          input.id,
          input.content,
        );
        if (inserted) return answer(userId, conversation, message, lock);

        if (message.conversationId !== conversation.id || message.role !== 'USER') {
          throw new AppError('INVALID_STATE', 'This message ID is already in use.');
        }
        const next = await repository.messageAt(conversation.id, message.seq + 1);
        if (!next) return answer(userId, conversation, message, lock);
        if (next.role === 'ASSISTANT' && next.status === 'COMPLETE') return replay(next, lock);
        if (next.role === 'ASSISTANT') return answer(userId, conversation, message, lock, next.id);
        throw new AppError('INVALID_STATE', 'This message was sent earlier in the conversation.');
      });
    },

    /**
     * Answers the last question again, replacing a failed (`ERROR`) answer. Also covers a
     * question left without any answer (the server stopped mid-way). Anything else → 409.
     */
    async retry(userId: string, conversationId: string): Promise<ChatRun> {
      const conversation = await ownedConversation(userId, conversationId);
      return underLock(conversation.id, async (lock) => {
        const last = await repository.lastMessage(conversation.id);
        if (last?.role === 'USER') return answer(userId, conversation, last, lock);
        if (last?.role === 'ASSISTANT' && last.status === 'ERROR') {
          const question = await repository.messageAt(conversation.id, last.seq - 1);
          if (question?.role === 'USER') {
            return answer(userId, conversation, question, lock, last.id);
          }
        }
        throw new AppError('INVALID_STATE', 'Only a failed answer can be retried.');
      });
    },

    /** Saves 👍 / 👎 (or clears it) and mirrors it to the answer's trace as a score. */
    async setFeedback(
      userId: string,
      messageId: string,
      value: 'UP' | 'DOWN' | null,
    ): Promise<Message> {
      const row = await repository.setFeedback(userId, messageId, value);
      if (!row) throw new NotFoundError('Message not found.');
      if (row.traceId) {
        const scoreId = `feedback-${row.id}`;
        try {
          if (value === null) await tracer.deleteScore(scoreId);
          else {
            await tracer.score({
              id: scoreId,
              traceId: row.traceId,
              name: 'user-feedback',
              value: value === 'UP' ? 1 : 0,
            });
          }
        } catch (err) {
          // The feedback is saved; the trace score is best effort.
          logger.warn({ err, messageId }, 'feedback score not sent');
        }
      }
      return toMessage(row);
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
