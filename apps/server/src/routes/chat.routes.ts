import { Router } from 'express';
import { createChatController } from '../controllers/chat.controller.js';
import type { RateLimiter } from '../lib/rate-limit/index.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { ChatService } from '../services/chat.service.js';

export function createChatRouter(service: ChatService, limiter: RateLimiter): Router {
  const controller = createChatController(service);
  const chatLimit = rateLimit(limiter, 'chatMessages');
  const router = Router();

  router.get('/notebooks/:notebookId/conversations', controller.listConversations);
  router.post('/notebooks/:notebookId/conversations', controller.createConversation);
  router.get('/conversations/:conversationId', controller.getConversation);
  router.patch('/conversations/:conversationId', controller.updateConversation);
  router.delete('/conversations/:conversationId', controller.deleteConversation);
  router.get('/conversations/:conversationId/messages', controller.listMessages);
  router.post('/conversations/:conversationId/messages', chatLimit, controller.sendMessage);
  router.post('/conversations/:conversationId/retry', chatLimit, controller.retry);
  router.put('/messages/:messageId/feedback', controller.setFeedback);

  return router;
}
