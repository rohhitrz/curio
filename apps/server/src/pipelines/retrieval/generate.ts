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
import { createMarkerFilter, stripDoneMarker } from '../tutor/marker.js';
import { TUTOR_INSTRUCTIONS, withTutorContext, type TutorContext } from '../tutor/prompt.js';

export interface GenerateAnswerInput {
  question: string;
  /** Best first, as retrieval returns them. */
  chunks: RetrievedChunk[];
  /** Recent messages, oldest first, without the new question. */
  history: LlmMessage[];
  summary?: string | null;
  /** The learner profile (Phase 7): shapes tone and depth only, never cited. */
  profile?: string | null;
  /**
   * False when routing skipped the search ("thanks!"): a short reply without sources instead of
   * "not in your sources". Defaults to true.
   */
  retrieved?: boolean;
  /**
   * Set for a lesson's tutor chat (L-10): the tutor's instructions, with the module, path and
   * lesson in context. No sources found is no refusal: the lesson may still answer it.
   */
  tutor?: TutorContext | null;
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
  /** Tutor only: the reply ended with the "ready to move on" marker (stripped from `text`). */
  suggestComplete: boolean;
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
  if (input.tutor) return generateTutorAnswer({ ...input, tutor: input.tutor }, deps);

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
        suggestComplete: false,
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
      profile: input.profile ?? null,
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
      suggestComplete: false,
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
    messages: buildReplyMessages({
      question: input.question,
      history: input.history,
      profile: input.profile ?? null,
    }),
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
      suggestComplete: false,
      model: llmResult.model,
      usage: llmResult.usage,
    };
  });
  result.catch(() => undefined);
  return { sources: [], textStream: stream.textStream, result };
}

/** Streams `textStream` without the marker; the learner never sees it. */
async function* withoutMarker(textStream: AsyncIterable<string>): AsyncGenerator<string> {
  const filter = createMarkerFilter();
  for await (const delta of textStream) {
    const out = filter.push(delta);
    if (out) yield out;
  }
  const { rest } = filter.end();
  if (rest) yield rest;
}

/**
 * A lesson's tutor (docs/02-system-design.md §9): the chat answer with the module, path and
 * lesson in context. The model is called even with no sources (the lesson may cover it), and a
 * final "ready to move on" marker becomes `suggestComplete` instead of text.
 */
function generateTutorAnswer(
  input: GenerateAnswerInput & { tutor: TutorContext },
  deps: GenerateAnswerDeps,
): AnswerStream {
  const context = buildContext(input.chunks, {
    maxTokens: deps.contextMaxTokens ?? retrieval.contextMaxTokens,
    countTokens: deps.countTokens,
  });
  const stream = deps.llm.stream({
    task: 'chatAnswer',
    instructions: TUTOR_INSTRUCTIONS,
    messages: withTutorContext(
      buildChatMessages({
        question: input.question,
        contextText: context.text || '(nothing in the resources matched this question)',
        summary: input.summary ?? null,
        history: input.history,
        profile: input.profile ?? null,
      }),
      input.tutor,
    ),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });

  const validMarkers = new Set(context.sources.map((source) => source.marker));
  const result = stream.result.then((llmResult): Answer => {
    const { text, found } = stripDoneMarker(llmResult.text);
    const checked = removeInvalidMarkers(text, validMarkers);
    return {
      text: checked.text,
      removedMarkers: checked.removed,
      citations: toCitationSnapshots(checked.text, context.sources, {
        snippetMaxChars: deps.snippetMaxChars ?? citationLimits.snippetMaxChars,
      }),
      refused: false,
      suggestComplete: found,
      model: llmResult.model,
      usage: llmResult.usage,
    };
  });
  result.catch(() => undefined);

  return { sources: context.sources, textStream: withoutMarker(stream.textStream), result };
}
