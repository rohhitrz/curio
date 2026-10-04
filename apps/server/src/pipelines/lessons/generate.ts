import type { CitationSnapshot } from '@curio/shared';
import type { LlmProvider, LlmUsage } from '../../lib/llm/index.js';
import { removeInvalidMarkers, toCitationSnapshots } from '../retrieval/citations.js';
import type { ContextSource } from '../retrieval/context.js';
import type { LessonContext } from './context.js';
import { buildLessonMessages, LESSON_INSTRUCTIONS, type LessonPromptInput } from './prompt.js';

export interface Lesson {
  /** Markdown with `[n]` markers, after the citation check: every marker has a citation. */
  text: string;
  /** Markers the model invented (no such passage) and the check removed. */
  removedMarkers: number[];
  citations: CitationSnapshot[];
  model: string;
  usage: LlmUsage;
}

export interface LessonStream {
  /** The numbered passages the model saw (for the trace). */
  sources: ContextSource[];
  /** Lesson text as it arrives. Throws `LlmError` if the call fails. */
  textStream: AsyncIterable<string>;
  /** Resolves after the text stream ends. Rejects with `LlmError` if the call fails. */
  result: Promise<Lesson>;
}

/**
 * Writes the lesson from its numbered passages (docs/02-system-design.md §9, decision L-10):
 * streamed, then the same citation check as chat. Concepts with no passages are taught as
 * general knowledge, so the model is called even when nothing was found.
 */
export function generateLesson(
  input: Omit<LessonPromptInput, 'concepts' | 'contextText'> & {
    context: LessonContext;
    abortSignal?: AbortSignal;
  },
  deps: { llm: LlmProvider; snippetMaxChars: number },
): LessonStream {
  const { context, abortSignal, ...prompt } = input;
  const stream = deps.llm.stream({
    task: 'lesson',
    instructions: LESSON_INSTRUCTIONS,
    messages: buildLessonMessages({
      ...prompt,
      concepts: context.concepts,
      contextText: context.text,
    }),
    ...(abortSignal ? { abortSignal } : {}),
  });

  const valid = new Set(context.sources.map((source) => source.marker));
  const result = stream.result.then((llm): Lesson => {
    const checked = removeInvalidMarkers(llm.text, valid);
    return {
      text: checked.text,
      removedMarkers: checked.removed,
      citations: toCitationSnapshots(checked.text, context.sources, {
        snippetMaxChars: deps.snippetMaxChars,
      }),
      model: llm.model,
      usage: llm.usage,
    };
  });
  // Callers that only read the text stream mustn't crash the process.
  result.catch(() => undefined);

  return { sources: context.sources, textStream: stream.textStream, result };
}
