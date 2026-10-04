import {
  createConversationSchema,
  messageFeedbackSchema,
  paginationQuerySchema,
  sendMessageSchema,
  updateConversationSchema,
} from '@curio/shared';
import type { RequestHandler } from 'express';
import { getUserId } from '../middleware/auth.js';
import type { ChatService } from '../services/chat.service.js';
import { conversationIdParam, messageIdParam, notebookIdParam } from './params.js';
import { stream } from './stream.js';

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
