import type { CitationSnapshot } from '@curio/shared';
import { citations as citationLimits, retrieval } from '../../config/index.js';
import type { LlmMessage, LlmProvider, LlmUsage } from '../../lib/llm/index.js';
import { removeInvalidMarkers, toCitationSnapshots } from './citations.js';
import { buildContext, type ContextSource } from './context.js';
import {
  buildChatMessages,
  buildReplyMessages,
  CHAT_ANSWER_INSTRUCTIONS,
  CHAT_REPLY_INSTRUCTIONS,
  NOT_IN_SOURCES_ANSWER,
} from './prompt.js';
import type { RetrievedChunk } from './retrieve.js';

export interface GenerateAnswerInput {
  question: string;
  /** Best first, as retrieval returns them. */
  chunks: RetrievedChunk[];
  /** Recent messages, oldest first, without the new question. */
  history: LlmMessage[];
  summary?: string | null;
  /**
   * False when routing skipped the search ("thanks!"): a short reply without sources instead of
   * "not in your sources". Defaults to true.
   */
  retrieved?: boolean;
  abortSignal?: AbortSignal;
}

export interface GenerateAnswerDeps {
  llm: LlmProvider;
  countTokens: (text: string) => number;
  /** Defaults to `retrieval.contextMaxTokens`. */
  contextMaxTokens?: number;
  /** Defaults to `citations.snippetMaxChars`. */
  snippetMaxChars?: number;
}

export interface Answer {
  /** With `[n]` markers, after the citation check: every marker has a citation. */
  text: string;
  /** Markers the model invented (no such source) and the check removed. */
  removedMarkers: number[];
  citations: CitationSnapshot[];
  /** The "not in your sources" reply, from the model or without calling it. */
  refused: boolean;
  /** Null when no model was called. */
  model: string | null;
  usage: LlmUsage | null;
}

export interface AnswerStream {
  /** The numbered sources the model saw (for the trace). */
  sources: ContextSource[];
  /** Answer text as it arrives. Throws `LlmError` if the call fails. */
  textStream: AsyncIterable<string>;
  /** Resolves after the text stream ends. Rejects with `LlmError` if the call fails. */
  result: Promise<Answer>;
}

/** A stream with just `text`, for answers that need no model call. */
function once(text: string): AsyncIterable<string> {
  return ReadableStream.from([text]);
}

const isRefusal = (text: string) => text.trim() === NOT_IN_SOURCES_ANSWER;

/**
 * Steps 6–7 of the chat pipeline (docs/02-system-design.md §7): numbers the retrieved chunks,
 * streams a grounded answer that cites them as `[n]`, and turns the markers into citation
 * snapshots. With no chunks it answers "not in your sources" without calling the model; a message
 * routed past retrieval gets a short reply with no sources.
 */
export function generateAnswer(input: GenerateAnswerInput, deps: GenerateAnswerDeps): AnswerStream {
  if (input.retrieved === false) return generateReply(input, deps);

  const context = buildContext(input.chunks, {
    maxTokens: deps.contextMaxTokens ?? retrieval.contextMaxTokens,
    countTokens: deps.countTokens,
  });

  if (context.sources.length === 0) {
    return {
      sources: [],
      textStream: once(NOT_IN_SOURCES_ANSWER),
      result: Promise.resolve({
        text: NOT_IN_SOURCES_ANSWER,
        removedMarkers: [],
        citations: [],
        refused: true,
        model: null,
        usage: null,
      }),
    };
  }

  const stream = deps.llm.stream({
    task: 'chatAnswer',
    instructions: CHAT_ANSWER_INSTRUCTIONS,
    messages: buildChatMessages({
      question: input.question,
      contextText: context.text,
      summary: input.summary ?? null,
      history: input.history,
    }),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });

  const validMarkers = new Set(context.sources.map((source) => source.marker));
  const result = stream.result.then((llmResult): Answer => {
    const refused = isRefusal(llmResult.text);
    // The text streamed live may still hold an invented marker (the web app hides markers with
    // no citation); the saved answer doesn't.
    const checked = removeInvalidMarkers(llmResult.text, validMarkers);
    return {
      text: checked.text,
      removedMarkers: checked.removed,
      citations: refused
        ? []
        : toCitationSnapshots(checked.text, context.sources, {
            snippetMaxChars: deps.snippetMaxChars ?? citationLimits.snippetMaxChars,
          }),
      refused,
      model: llmResult.model,
      usage: llmResult.usage,
    };
  });
  // Same as the provider: callers that only read the text stream mustn't crash the process.
  result.catch(() => undefined);

  return { sources: context.sources, textStream: stream.textStream, result };
}

function generateReply(input: GenerateAnswerInput, deps: GenerateAnswerDeps): AnswerStream {
  const stream = deps.llm.stream({
    task: 'chatReply',
    instructions: CHAT_REPLY_INSTRUCTIONS,
    messages: buildReplyMessages({ question: input.question, history: input.history }),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  const result = stream.result.then((llmResult): Answer => {
    // No sources here, so any marker is invented.
    const checked = removeInvalidMarkers(llmResult.text, new Set());
    return {
      text: checked.text,
      removedMarkers: checked.removed,
      citations: [],
      refused: false,
      model: llmResult.model,
      usage: llmResult.usage,
    };
  });
  result.catch(() => undefined);
  return { sources: [], textStream: stream.textStream, result };
}
