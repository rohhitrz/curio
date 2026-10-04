import {
  chatMessageMetadataSchema,
  chatStreamDataSchemas,
  type CitationSnapshot,
} from '@curio/shared';
import { parseJsonEventStream, uiMessageChunkSchema, type UIMessageChunk } from 'ai';

/** An answer as it streams in (docs/04-api-design.md §8). */
export interface AnswerState {
  /** The answer's message ID, from `start`. */
  messageId: string | null;
  text: string;
  /** Latest progress line ("Searching your sources…"), until text arrives. */
  status: string | null;
  citations: CitationSnapshot[];
  error: { code: string; message: string } | null;
  traceId: string | null;
  /** Tutor only: the learner seems ready to mark this module done. */
  suggestComplete: { moduleId: string } | null;
  done: boolean;
}

export const emptyAnswer: AnswerState = {
  messageId: null,
  text: '',
  status: null,
  citations: [],
  error: null,
  traceId: null,
  suggestComplete: null,
  done: false,
};

/** Folds one stream chunk into the answer. Unknown or malformed chunks are ignored. */
export function applyChunk(state: AnswerState, chunk: UIMessageChunk): AnswerState {
  switch (chunk.type) {
    case 'start':
      return { ...state, messageId: chunk.messageId ?? state.messageId };
    case 'text-delta':
      return { ...state, text: state.text + chunk.delta, status: null };
    case 'data-status': {
      const parsed = chatStreamDataSchemas.status.safeParse(chunk.data);
      return parsed.success ? { ...state, status: parsed.data.message } : state;
    }
    case 'data-citations': {
      const parsed = chatStreamDataSchemas.citations.safeParse(chunk.data);
      return parsed.success ? { ...state, citations: parsed.data } : state;
    }
    case 'data-action': {
      const parsed = chatStreamDataSchemas.action.safeParse(chunk.data);
      return parsed.success
        ? { ...state, suggestComplete: { moduleId: parsed.data.moduleId } }
        : state;
    }
    case 'data-error': {
      const parsed = chatStreamDataSchemas.error.safeParse(chunk.data);
      return parsed.success ? { ...state, error: parsed.data, status: null } : state;
    }
    case 'error':
      // `data-error` carries the code; keep it if it came first.
      return {
        ...state,
        status: null,
        error: state.error ?? { code: 'INTERNAL_ERROR', message: chunk.errorText },
      };
    case 'finish': {
      const metadata = chatMessageMetadataSchema.safeParse(chunk.messageMetadata ?? {});
      return {
        ...state,
        status: null,
        done: true,
        traceId: (metadata.success ? metadata.data.traceId : undefined) ?? state.traceId,
      };
    }
    default:
      return state;
  }
}

/** Decodes the SSE body into UI message chunks; lines that don't parse are skipped. */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<UIMessageChunk> {
  const reader = parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema }).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.success) yield value.value;
    }
  } finally {
    reader.releaseLock();
  }
}
