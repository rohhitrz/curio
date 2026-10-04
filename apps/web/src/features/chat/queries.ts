'use client';

import {
  conversationListSchema,
  conversationSchema,
  messageListSchema,
  messageSchema,
  type Conversation,
  type Feedback,
  type Message,
} from '@curio/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useApi } from '@/app/providers';
import { notebookKeys } from '@/features/notebooks/queries';

/** Conversations shown in the picker (most recent first). */
const CONVERSATION_LIMIT = 50;
/** Messages per page; older ones load with "Show earlier messages". */
const MESSAGE_PAGE_SIZE = 30;

export const chatKeys = {
  all: ['chat'] as const,
  conversations: (notebookId: string) => [...chatKeys.all, 'conversations', notebookId] as const,
  messages: (conversationId: string) => [...chatKeys.all, 'messages', conversationId] as const,
};

type MessagePages = InfiniteData<{ items: Message[]; nextCursor: string | null }>;

export function useConversations(notebookId: string) {
  const api = useApi();
  return useQuery({
    queryKey: chatKeys.conversations(notebookId),
    queryFn: ({ signal }) =>
      api.get(`/notebooks/${notebookId}/conversations`, {
        schema: conversationListSchema,
        query: { limit: CONVERSATION_LIMIT },
        signal,
      }),
    select: (data) => data.items,
  });
}

/** After creating or deleting, refresh the picker and the notebook's `conversationCount`. */
function useRefreshConversations(notebookId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: chatKeys.conversations(notebookId) }),
      queryClient.invalidateQueries({ queryKey: notebookKeys.detail(notebookId) }),
    ]);
}

export function useCreateConversation(notebookId: string) {
  const api = useApi();
  const refresh = useRefreshConversations(notebookId);
  return useMutation({
    /** `lessonId` → a lesson's tutor chat. */
    mutationFn: (lessonId?: string) =>
      api.post<Conversation>(
        `/notebooks/${notebookId}/conversations`,
        lessonId ? { lessonId } : {},
        {
          schema: conversationSchema,
        },
      ),
    onSuccess: refresh,
  });
}

export function useRenameConversation(notebookId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Conversation>(`/conversations/${id}`, { title }, { schema: conversationSchema }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: chatKeys.conversations(notebookId) }),
  });
}

export function useDeleteConversation(notebookId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = useRefreshConversations(notebookId);
  return useMutation({
    mutationFn: (id: string) => api.delete(`/conversations/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: chatKeys.messages(id) });
      return refresh();
    },
  });
}

/** The conversation's messages, oldest first; older pages load on demand. */
export function useMessages(conversationId: string | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: chatKeys.messages(conversationId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/conversations/${conversationId ?? ''}/messages`, {
        schema: messageListSchema,
        query: { limit: MESSAGE_PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: conversationId !== null,
    // Pages come newest first; the chat reads top to bottom.
    select: (data) => data.pages.flatMap((page) => page.items).reverse(),
  });
}

/** 👍 / 👎 on an answer, shown at once and rolled back if the request fails. */
export function useMessageFeedback(conversationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = chatKeys.messages(conversationId);

  const setFeedback = (messageId: string, value: Feedback | null) =>
    queryClient.setQueryData<MessagePages>(key, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((m) => (m.id === messageId ? { ...m, feedback: value } : m)),
            })),
          }
        : data,
    );

  return useMutation({
    mutationFn: ({ messageId, value }: { messageId: string; value: Feedback | null }) =>
      api.put<Message>(`/messages/${messageId}/feedback`, { value }, { schema: messageSchema }),
    onMutate: async ({ messageId, value }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient
        .getQueryData<MessagePages>(key)
        ?.pages.flatMap((page) => page.items)
        .find((m) => m.id === messageId)?.feedback;
      setFeedback(messageId, value);
      return { previous: previous ?? null };
    },
    onError: (_error, { messageId }, context) => {
      if (context) setFeedback(messageId, context.previous);
    },
  });
}
