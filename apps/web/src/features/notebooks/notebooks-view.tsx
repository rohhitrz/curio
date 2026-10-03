'use client';

import type { Notebook } from '@curio/shared';
import { GraduationCap, NotebookPen, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DeleteNotebookDialog } from './delete-notebook-dialog';
import { NotebookCard } from './notebook-card';
import { NotebookTitleDialog } from './notebook-title-dialog';
import { useCreateNotebook, useDeleteNotebook, useNotebooks, useRenameNotebook } from './queries';

type DialogState =
  | { type: 'create' }
  | { type: 'rename'; notebook: Notebook }
  | { type: 'delete'; notebook: Notebook }
  | null;

export function NotebooksView() {
  const notebooks = useNotebooks();
  const createNotebook = useCreateNotebook();
  const renameNotebook = useRenameNotebook();
  const deleteNotebook = useDeleteNotebook();
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Notebooks</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/learn" />}>
            <GraduationCap />
            Learn a topic
          </Button>
          <Button onClick={() => setDialog({ type: 'create' })}>
            <Plus />
            New notebook
          </Button>
        </div>
      </div>

      <section className="mt-6" aria-live="polite">
        {notebooks.isPending ? (
          <NotebookGrid>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </NotebookGrid>
        ) : notebooks.isError ? (
          <div className="rounded-xl border p-8 text-center">
            <p className="font-medium">Couldn’t load your notebooks.</p>
            <p className="text-muted-foreground mt-1 text-sm">{notebooks.error.message}</p>
            <Button variant="outline" className="mt-4" onClick={() => void notebooks.refetch()}>
              Try again
            </Button>
          </div>
        ) : notebooks.data.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
            <NotebookPen className="text-muted-foreground size-8" aria-hidden />
            <p className="mt-4 font-medium">No notebooks yet</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              A notebook holds your sources on one subject. Create one to get started.
            </p>
            <Button className="mt-6" onClick={() => setDialog({ type: 'create' })}>
              <Plus />
              New notebook
            </Button>
          </div>
        ) : (
          <>
            <NotebookGrid>
              {notebooks.data.map((notebook) => (
                <NotebookCard
                  key={notebook.id}
                  notebook={notebook}
                  onRename={() => setDialog({ type: 'rename', notebook })}
                  onDelete={() => setDialog({ type: 'delete', notebook })}
                />
              ))}
            </NotebookGrid>
            {notebooks.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button
                  variant="outline"
                  disabled={notebooks.isFetchingNextPage}
                  onClick={() => void notebooks.fetchNextPage()}
                >
                  {notebooks.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <NotebookTitleDialog
        mode="create"
        open={dialog?.type === 'create'}
        onOpenChange={close}
        onSubmit={(title) => createNotebook.mutateAsync(title)}
      />
      <NotebookTitleDialog
        mode="rename"
        open={dialog?.type === 'rename'}
        onOpenChange={close}
        initialTitle={dialog?.type === 'rename' ? dialog.notebook.title : ''}
        onSubmit={(title) =>
          dialog?.type === 'rename'
            ? renameNotebook.mutateAsync({ id: dialog.notebook.id, title })
            : Promise.resolve()
        }
      />
      <DeleteNotebookDialog
        open={dialog?.type === 'delete'}
        onOpenChange={close}
        title={dialog?.type === 'delete' ? dialog.notebook.title : ''}
        onConfirm={() =>
          dialog?.type === 'delete'
            ? deleteNotebook.mutateAsync(dialog.notebook.id)
            : Promise.resolve()
        }
      />
    </main>
  );
}

function NotebookGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}
