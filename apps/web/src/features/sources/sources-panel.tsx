'use client';

import type { Source } from '@curio/shared';
import { Library, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AddSourceDialog } from './add-source-dialog';
import {
  useDeleteSource,
  useOpenSourceFile,
  useRenameSource,
  useReprocessSource,
  useSources,
} from './queries';
import { DeleteSourceDialog, RenameSourceDialog } from './source-dialogs';
import { SourceRow } from './source-row';
import { SourceViewerDialog } from './source-viewer-dialog';

type DialogState =
  | { type: 'add' }
  | { type: 'rename'; source: Source }
  | { type: 'delete'; source: Source }
  | { type: 'view'; source: Source }
  | null;

const HIGHLIGHT_MS = 2_500;

export function SourcesPanel({ notebookId }: { notebookId: string }) {
  const sources = useSources(notebookId);
  const renameSource = useRenameSource(notebookId);
  const deleteSource = useDeleteSource(notebookId);
  const openFile = useOpenSourceFile();
  const reprocessSource = useReprocessSource(notebookId);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  // Scroll to and briefly highlight a source (e.g. the one a duplicate points at).
  useEffect(() => {
    if (!highlightedId) return;
    document
      .getElementById(`source-${highlightedId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => setHighlightedId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  async function openPdf(source: Source) {
    setActionError(null);
    // Open the tab during the click, or the browser blocks it as a pop-up once we await.
    const tab = window.open('', '_blank');
    try {
      const { url } = await openFile.mutateAsync(source.id);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err) {
      tab?.close();
      setActionError(err instanceof Error ? err.message : 'Couldn’t open the PDF.');
    }
  }

  async function reprocess(source: Source) {
    setActionError(null);
    try {
      await reprocessSource.mutateAsync(source.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Couldn’t retry this source.');
    }
  }

  return (
    <section className="mt-8" aria-labelledby="sources-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sources-heading" className="text-lg font-semibold tracking-tight">
          Sources
          {sources.data && sources.data.length > 0 && (
            <span className="text-muted-foreground ml-2 text-sm font-normal">
              {sources.data.length}
            </span>
          )}
        </h2>
        <Button size="sm" onClick={() => setDialog({ type: 'add' })}>
          <Plus />
          Add source
        </Button>
      </div>

      {actionError && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          {actionError}
        </p>
      )}

      <div className="mt-4" aria-live="polite">
        {sources.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : sources.isError ? (
          <div className="rounded-xl border p-6 text-center">
            <p className="font-medium">Couldn’t load sources.</p>
            <p className="text-muted-foreground mt-1 text-sm">{sources.error.message}</p>
            <Button variant="outline" className="mt-4" onClick={() => void sources.refetch()}>
              Try again
            </Button>
          </div>
        ) : sources.data.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center">
            <Library className="text-muted-foreground size-8" aria-hidden />
            <p className="mt-4 font-medium">No sources yet</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Add PDFs, web pages, YouTube videos or your own notes. Answers in this notebook come
              only from its sources.
            </p>
            <Button className="mt-6" onClick={() => setDialog({ type: 'add' })}>
              <Plus />
              Add source
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {sources.data.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                highlighted={source.id === highlightedId}
                retrying={reprocessSource.isPending && reprocessSource.variables === source.id}
                onOpenFile={() => void openPdf(source)}
                onView={() => setDialog({ type: 'view', source })}
                onReprocess={() => void reprocess(source)}
                onRename={() => setDialog({ type: 'rename', source })}
                onDelete={() => setDialog({ type: 'delete', source })}
              />
            ))}
          </ul>
        )}
      </div>

      <AddSourceDialog
        notebookId={notebookId}
        open={dialog?.type === 'add'}
        onOpenChange={close}
        onDuplicate={setHighlightedId}
      />
      <SourceViewerDialog
        source={dialog?.type === 'view' ? dialog.source : null}
        onOpenChange={close}
      />
      <RenameSourceDialog
        open={dialog?.type === 'rename'}
        onOpenChange={close}
        initialTitle={dialog?.type === 'rename' ? dialog.source.title : ''}
        onSubmit={(title) =>
          dialog?.type === 'rename'
            ? renameSource.mutateAsync({ id: dialog.source.id, title })
            : Promise.resolve()
        }
      />
      <DeleteSourceDialog
        open={dialog?.type === 'delete'}
        onOpenChange={close}
        title={dialog?.type === 'delete' ? dialog.source.title : ''}
        onConfirm={() =>
          dialog?.type === 'delete' ? deleteSource.mutateAsync(dialog.source.id) : Promise.resolve()
        }
      />
    </section>
  );
}
