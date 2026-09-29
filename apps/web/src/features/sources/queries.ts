'use client';

import {
  fileUrlResponseSchema,
  sourceListSchema,
  sourceSchema,
  uploadResponseSchema,
  type CreateSourceInput,
  type Source,
} from '@curio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers';
import { notebookKeys } from '@/features/notebooks/queries';
import { hasActiveSources, pdfContentType, putFile, sha256Hex, titleFromFileName } from './upload';

/** API doc §1: the frontend polls about every 2s until every source is READY or FAILED. */
const POLL_INTERVAL_MS = 2_000;

export const sourceKeys = {
  all: ['sources'] as const,
  list: (notebookId: string) => [...sourceKeys.all, 'list', notebookId] as const,
};

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
    onSuccess: refresh,
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

/** Hash in the browser → signed upload URL → PUT straight to R2 → register the source. */
export function useUploadPdf(notebookId: string) {
  const api = useApi();
  const refresh = useRefreshSources(notebookId);
  return useMutation({
    mutationFn: async ({ file, title, onStage, onProgress, signal }: PdfUploadInput) => {
      onStage?.('hashing');
      const contentHash = await sha256Hex(await file.arrayBuffer());

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
        { schema: sourceSchema, signal },
      );
    },
    onSuccess: refresh,
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

/** Signed, short-lived URL for viewing a PDF source. Fetched on demand, never cached. */
export function useOpenSourceFile() {
  const api = useApi();
  return useMutation({
    mutationFn: (id: string) =>
      api.get(`/sources/${id}/file-url`, { schema: fileUrlResponseSchema }),
  });
}
