'use client';

import {
  notebookDetailSchema,
  notebookSchema,
  paginatedResponseSchema,
  type Notebook,
} from '@curio/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers';

const PAGE_SIZE = 20;
const listSchema = paginatedResponseSchema(notebookSchema);

export const notebookKeys = {
  all: ['notebooks'] as const,
  list: () => [...notebookKeys.all, 'list'] as const,
  detail: (id: string) => [...notebookKeys.all, 'detail', id] as const,
};

export function useNotebooks() {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: notebookKeys.list(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/notebooks', {
        query: { limit: PAGE_SIZE, cursor: pageParam },
        schema: listSchema,
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useNotebook(notebookId: string) {
  const api = useApi();
  return useQuery({
    queryKey: notebookKeys.detail(notebookId),
    queryFn: ({ signal }) =>
      api.get(`/notebooks/${notebookId}`, { schema: notebookDetailSchema, signal }),
  });
}

export function useCreateNotebook() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title: string) =>
      api.post<Notebook>('/notebooks', { title }, { schema: notebookSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notebookKeys.list() }),
  });
}

export function useRenameNotebook() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Notebook>(`/notebooks/${id}`, { title }, { schema: notebookSchema }),
    onSuccess: (notebook) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: notebookKeys.list() }),
        queryClient.invalidateQueries({ queryKey: notebookKeys.detail(notebook.id) }),
      ]),
  });
}

export function useDeleteNotebook() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/notebooks/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: notebookKeys.detail(id) });
      return queryClient.invalidateQueries({ queryKey: notebookKeys.list() });
    },
  });
}
