'use client';

import {
  learningPathSchema,
  lessonSchema,
  moduleSchema,
  outlineSchema,
  prefillResponseSchema,
  scopeResponseSchema,
  startPathResponseSchema,
  type LearningPath,
  type Level,
  type Module,
  type Outline,
  type StartPathInput,
  type StartPathResponse,
} from '@curio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers';
import { notebookKeys } from '@/features/notebooks/queries';
import { isApiError } from '@/lib/api';
import { shouldPoll, withModuleEnabled } from './display';

/** How often a path in progress is polled (docs/04-api-design.md §1, "Async operations"). */
const POLL_MS = 2_000;

export const pathKeys = {
  all: ['learning-paths'] as const,
  prefill: (topic: string) => [...pathKeys.all, 'prefill', topic] as const,
  detail: (id: string) => [...pathKeys.all, 'detail', id] as const,
  outline: (id: string) => [...pathKeys.all, 'outline', id] as const,
  lesson: (moduleId: string) => [...pathKeys.all, 'lesson', moduleId] as const,
};

/**
 * Is the topic focused enough for one path? Asked when the learner presses "Build my path";
 * never blocks (the server answers "not broad" when it can't tell).
 */
export function useScopeCheck() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ topic, level }: { topic: string; level: Level }) =>
      api.get('/learning-paths/scope', { query: { topic, level }, schema: scopeResponseSchema }),
  });
}

/** A module's latest lesson; `LESSON_NOT_GENERATED` (404) means it is to be written now. */
export function useLesson(moduleId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: pathKeys.lesson(moduleId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/modules/${moduleId ?? ''}/lesson`, { schema: lessonSchema, signal }),
    enabled: moduleId !== null,
    retry: (count, error) => !isApiError(error) && count < 2,
  });
}

/** Marks a module done or not done; the outline (progress, done ticks) is reloaded. */
export function useCompleteModule(pathId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ moduleId, completed }: { moduleId: string; completed: boolean }) =>
      api.put<Module>(`/modules/${moduleId}/completion`, { completed }, { schema: moduleSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pathKeys.outline(pathId) }),
  });
}

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
