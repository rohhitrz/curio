'use client';

import {
  fileUrlResponseSchema,
  sourceChunkListSchema,
  sourceContentSchema,
  sourceListSchema,
  sourceSchema,
  uploadResponseSchema,
  type CreateSourceInput,
  type Source,
} from '@curio/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers';
import { notebookKeys } from '@/features/notebooks/queries';
import { hasActiveSources, pdfContentType, putFile, sha256Hex, titleFromFileName } from './upload';

/** API doc §1: the frontend polls about every 2s until every source is READY or FAILED. */
const POLL_INTERVAL_MS = 2_000;

export const sourceKeys = {
  all: ['sources'] as const,
  list: (notebookId: string) => [...sourceKeys.all, 'list', notebookId] as const,
  content: (sourceId: string) => [...sourceKeys.all, 'content', sourceId] as const,
  chunks: (sourceId: string) => [...sourceKeys.all, 'chunks', sourceId] as const,
};

/** Chunks fetched per "Load more" in the viewer. */
const CHUNK_PAGE_SIZE = 20;

export function useSources(notebookId: string) {
  const api = useApi();
  return useQuery({
    queryKey: sourceKeys.list(notebookId),
    queryFn: ({ signal }) =>
      api.get(`/notebooks/${notebookId}/sources`, { schema: sourceListSchema, signal }),
    select: (data) => data.items,
    refetchInterval: (query) =>
      hasActiveSources(query.state.data?.items ?? []) ? POLL_INTERVAL_MS : false,
  });
}

/** After adding or deleting, refresh the list and the notebook's `sourceCount`. */
function useRefreshSources(notebookId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sourceKeys.list(notebookId) }),
      queryClient.invalidateQueries({ queryKey: notebookKeys.detail(notebookId) }),
    ]);
}

/** Website, YouTube and text sources: one request. */
export function useAddSource(notebookId: string) {
  const api = useApi();
  const refresh = useRefreshSources(notebookId);
  return useMutation({
    mutationFn: (input: Exclude<CreateSourceInput, { type: 'PDF' }>) =>
      api.post<Source>(`/notebooks/${notebookId}/sources`, input, { schema: sourceSchema }),
    onSettled: refresh,
  });
}

export type PdfUploadStage = 'hashing' | 'uploading' | 'registering';

interface PdfUploadInput {
  file: File;
  title?: string;
  onStage?: (stage: PdfUploadStage) => void;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Hash in the browser → signed upload URL → PUT straight to R2 → register the source.
 * `signal` cancels only the hashing and upload. Once the file is in R2 the source is always
 * registered, so a cancel can't leave an orphaned file or a source the list doesn't show.
 */
export function useUploadPdf(notebookId: string) {
  const api = useApi();
  const refresh = useRefreshSources(notebookId);
  return useMutation({
    mutationFn: async ({ file, title, onStage, onProgress, signal }: PdfUploadInput) => {
      onStage?.('hashing');
      const contentHash = await sha256Hex(await file.arrayBuffer());
      signal?.throwIfAborted();

      const upload = await api.post(
        `/notebooks/${notebookId}/uploads`,
        { fileName: file.name, fileSize: file.size, contentType: pdfContentType(file) },
        { schema: uploadResponseSchema, signal },
      );

      onStage?.('uploading');
      await putFile(upload.uploadUrl, file, { onProgress, signal });

      onStage?.('registering');
      return api.post<Source>(
        `/notebooks/${notebookId}/sources`,
        {
          type: 'PDF',
          title: title?.trim() || titleFromFileName(file.name),
          storageKey: upload.storageKey,
          contentHash,
        },
        { schema: sourceSchema },
      );
    },
    // On settle, not just success: a cancelled or failed add may still have created the source.
    // Hook-level callbacks run even after the dialog unmounts.
    onSettled: refresh,
  });
}

export function useRenameSource(notebookId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Source>(`/sources/${id}`, { title }, { schema: sourceSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sourceKeys.list(notebookId) }),
  });
}

export function useDeleteSource(notebookId: string) {
  const api = useApi();
  const refresh = useRefreshSources(notebookId);
  return useMutation({
    mutationFn: (id: string) => api.delete(`/sources/${id}`),
    onSuccess: refresh,
  });
}

/**
 * Processes a `READY` or `FAILED` source again. The list is refreshed on settle, which also
 * restarts polling now that the source is `PENDING`.
 */
export function useReprocessSource(notebookId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<Source>(`/sources/${id}/reprocess`, undefined, { schema: sourceSchema }),
    onSettled: (_data, _error, id) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sourceKeys.list(notebookId) }),
        // The text and chunks are about to be replaced.
        queryClient.invalidateQueries({ queryKey: sourceKeys.content(id) }),
        queryClient.invalidateQueries({ queryKey: sourceKeys.chunks(id) }),
      ]),
  });
}

/** The source's extracted text, for the viewer. Fetched only while a source is being viewed. */
export function useSourceContent(sourceId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: sourceKeys.content(sourceId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/sources/${sourceId ?? ''}/content`, { schema: sourceContentSchema, signal }),
    enabled: sourceId !== null,
    select: (data) => data.content,
  });
}

/** The source's chunks in document order, loaded a page at a time. */
export function useSourceChunks(sourceId: string | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: sourceKeys.chunks(sourceId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/sources/${sourceId ?? ''}/chunks`, {
        schema: sourceChunkListSchema,
        query: { limit: CHUNK_PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: sourceId !== null,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

/** Signed, short-lived URL for viewing a PDF source. Fetched on demand, never cached. */
export function useOpenSourceFile() {
  const api = useApi();
  return useMutation({
    mutationFn: (id: string) =>
      api.get(`/sources/${id}/file-url`, { schema: fileUrlResponseSchema }),
  });
}
