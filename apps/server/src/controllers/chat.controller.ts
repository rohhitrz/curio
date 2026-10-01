import {
  createConversationSchema,
  messageFeedbackSchema,
  paginationQuerySchema,
  sendMessageSchema,
  updateConversationSchema,
  type ChatMessageMetadata,
  type CitationSnapshot,
} from '@curio/shared';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai';
import type { RequestHandler, Response } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { ChatEvent, ChatRun, ChatService } from '../services/chat.service.js';
import { conversationIdParam, messageIdParam, notebookIdParam } from './params.js';

/** The chat stream's message type (shared data schemas: `chatStreamDataSchemas`). */
type ChatUIMessage = UIMessage<
  ChatMessageMetadata,
  {
    status: { message: string };
    citations: CitationSnapshot[];
    error: { code: string; message: string };
  }
>;

/** One stream event → AI SDK UI message chunks. */
function write(writer: UIMessageStreamWriter<ChatUIMessage>, event: ChatEvent, textId: string) {
  switch (event.type) {
    case 'start':
      writer.write({ type: 'start', messageId: event.messageId });
      writer.write({ type: 'text-start', id: textId });
      return;
    case 'status':
      writer.write({ type: 'data-status', data: { message: event.message }, transient: true });
      return;
    case 'text':
      writer.write({ type: 'text-delta', id: textId, delta: event.delta });
      return;
    case 'citations':
      writer.write({ type: 'data-citations', data: event.citations });
      return;
    case 'error':
      writer.write({ type: 'data-error', data: { code: event.code, message: event.message } });
      writer.write({ type: 'error', errorText: event.message });
      return;
    case 'finish':
      writer.write({ type: 'text-end', id: textId });
      writer.write({
        type: 'finish',
        messageMetadata: event.traceId ? { traceId: event.traceId } : {},
      });
      return;
  }
}

/**
 * Streams a run as SSE (docs/04-api-design.md §8). The run is awaited to the end even if the
 * client goes away, so the answer is still generated and saved; writes to a closed stream are
 * dropped.
 */
async function stream(res: Response, chatRun: ChatRun): Promise<void> {
  let finished: Promise<void> = Promise.resolve();
  const uiStream = createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) => {
      const textId = crypto.randomUUID();
      finished = chatRun.run((event) => {
        try {
          write(writer, event, textId);
        } catch {
          // The client disconnected; keep generating.
        }
      });
      return finished;
    },
  });
  await pipeUIMessageStreamToResponse({ response: res, stream: uiStream });
  await finished;
}

export function createChatController(service: ChatService) {
  const listConversations: RequestHandler = async (req, res) => {
    const notebookId = notebookIdParam(req);
    const { limit, cursor } = paginationQuerySchema.parse(req.query);
    res.json(await service.listConversations(getUserId(req), notebookId, limit, cursor));
  };

  const createConversation: RequestHandler = async (req, res) => {
    const notebookId = notebookIdParam(req);
    const { lessonId } = createConversationSchema.parse(req.body ?? {});
    res.status(201).json(await service.createConversation(getUserId(req), notebookId, lessonId));
  };

  const getConversation: RequestHandler = async (req, res) => {
    res.json(await service.getConversation(getUserId(req), conversationIdParam(req)));
  };

  const updateConversation: RequestHandler = async (req, res) => {
    const conversationId = conversationIdParam(req);
    const { title } = updateConversationSchema.parse(req.body);
    res.json(await service.renameConversation(getUserId(req), conversationId, title));
  };

  const deleteConversation: RequestHandler = async (req, res) => {
    await service.deleteConversation(getUserId(req), conversationIdParam(req));
    res.status(204).end();
  };

  const listMessages: RequestHandler = async (req, res) => {
    const conversationId = conversationIdParam(req);
    const { limit, cursor } = paginationQuerySchema.parse(req.query);
    res.json(await service.listMessages(getUserId(req), conversationId, limit, cursor));
  };

  const sendMessage: RequestHandler = async (req, res) => {
    const conversationId = conversationIdParam(req);
    const input = sendMessageSchema.parse(req.body);
    await stream(res, await service.send(getUserId(req), conversationId, input));
  };

  const retry: RequestHandler = async (req, res) => {
    await stream(res, await service.retry(getUserId(req), conversationIdParam(req)));
  };

  const setFeedback: RequestHandler = async (req, res) => {
    const messageId = messageIdParam(req);
    const { value } = messageFeedbackSchema.parse(req.body);
    res.json(await service.setFeedback(getUserId(req), messageId, value));
  };

  return {
    listConversations,
    createConversation,
    getConversation,
    updateConversation,
    deleteConversation,
    listMessages,
    sendMessage,
    retry,
    setFeedback,
  };
}
