'use client';

import { memoryListSchema, memorySchema, type Memory, type UpdateMemoryInput } from '@curio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers';

export const memoryKeys = {
  all: ['memories'] as const,
  list: () => [...memoryKeys.all, 'list'] as const,
};

/** All of the user's memories (at most 200, not paginated). */
export function useMemories() {
  const api = useApi();
  return useQuery({
    queryKey: memoryKeys.list(),
    queryFn: ({ signal }) => api.get('/memories', { schema: memoryListSchema, signal }),
    select: (data) => data.items,
  });
}

export function useUpdateMemory() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMemoryInput }) =>
      api.patch<Memory>(`/memories/${id}`, input, { schema: memorySchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryKeys.list() }),
  });
}

export function useDeleteMemory() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/memories/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryKeys.list() }),
  });
}

export function useDeleteAllMemories() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/memories'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryKeys.list() }),
  });
}
