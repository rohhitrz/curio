'use client';

import {
  learningPathSchema,
  moduleSchema,
  outlineSchema,
  prefillResponseSchema,
  startPathResponseSchema,
  type LearningPath,
  type Module,
  type Outline,
  type StartPathInput,
  type StartPathResponse,
} from '@curio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers';
import { notebookKeys } from '@/features/notebooks/queries';
import { shouldPoll, withModuleEnabled } from './display';

/** How often a path in progress is polled (docs/04-api-design.md §1, "Async operations"). */
const POLL_MS = 2_000;

export const pathKeys = {
  all: ['learning-paths'] as const,
  prefill: (topic: string) => [...pathKeys.all, 'prefill', topic] as const,
  detail: (id: string) => [...pathKeys.all, 'detail', id] as const,
  outline: (id: string) => [...pathKeys.all, 'outline', id] as const,
};

/** A level the learner confirmed before, for this topic or a related one. */
export function usePrefill(topic: string) {
  const api = useApi();
  return useQuery({
    queryKey: pathKeys.prefill(topic),
    queryFn: ({ signal }) =>
      api.get('/learning-paths/prefill', {
        query: { topic },
        schema: prefillResponseSchema,
        signal,
      }),
    enabled: topic.length > 0,
    staleTime: 60_000,
    select: (data) => data.match,
  });
}

export function useStartPath() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartPathInput) =>
      api.post<StartPathResponse>('/learning-paths', input, { schema: startPathResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notebookKeys.list() }),
  });
}

/** The path, polled while the job works. */
export function usePath(pathId: string) {
  const api = useApi();
  return useQuery({
    queryKey: pathKeys.detail(pathId),
    queryFn: ({ signal }) =>
      api.get(`/learning-paths/${pathId}`, { schema: learningPathSchema, signal }),
    refetchInterval: (query) =>
      query.state.data && !shouldPoll(query.state.data) ? false : POLL_MS,
  });
}

/** The outline, once the path is `READY`. */
export function useOutline(pathId: string, ready: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: pathKeys.outline(pathId),
    queryFn: ({ signal }) =>
      api.get(`/learning-paths/${pathId}/outline`, { schema: outlineSchema, signal }),
    enabled: ready,
  });
}

/** Branch pick and retry both answer with the path: it replaces the cached one. */
function useCachePath() {
  const queryClient = useQueryClient();
  return (path: LearningPath) => queryClient.setQueryData(pathKeys.detail(path.id), path);
}

export function useSelectBranch() {
  const api = useApi();
  const cache = useCachePath();
  return useMutation({
    mutationFn: ({ pathId, branch }: { pathId: string; branch: string }) =>
      api.post(`/learning-paths/${pathId}/branch`, { branch }, { schema: learningPathSchema }),
    onSuccess: cache,
  });
}

export function useRetryPath() {
  const api = useApi();
  const cache = useCachePath();
  return useMutation({
    mutationFn: (pathId: string) =>
      api.post(`/learning-paths/${pathId}/retry`, undefined, { schema: learningPathSchema }),
    onSuccess: cache,
  });
}

/** Turns a module on or off; the outline is updated in place right away. */
export function useToggleModule(pathId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = pathKeys.outline(pathId);
  return useMutation({
    mutationFn: ({ moduleId, isEnabled }: { moduleId: string; isEnabled: boolean }) =>
      api.patch<Module>(`/modules/${moduleId}`, { isEnabled }, { schema: moduleSchema }),
    onMutate: async ({ moduleId, isEnabled }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Outline>(key);
      if (previous) queryClient.setQueryData(key, withModuleEnabled(previous, moduleId, isEnabled));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
