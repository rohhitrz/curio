'use client';

import { ArrowLeft, GraduationCap } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api';
import { ChatPanel } from '@/features/chat/chat-panel';
import { SourcesPanel } from '@/features/sources/sources-panel';
import { displayTitle, timeAgo } from '@/lib/format';
import { NotebookKindTag } from './notebook-kind-tag';
import { useNotebook } from './queries';

export function NotebookDetailView({ notebookId }: { notebookId: string }) {
  const notebook = useNotebook(notebookId);

  return (
    // On wide screens the page fills the window under the site header (h-14 + border): the
    // sources and the chat scroll on their own, so the message box is always in view.
    <main className="mx-auto flex max-w-7xl flex-col px-4 py-4 lg:h-[calc(100dvh-3.5rem-1px)]">
      <div className="flex min-w-0 items-start gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Back to notebooks"
          nativeButton={false}
          render={<Link href="/notebooks" />}
        >
          <ArrowLeft />
        </Button>
        {notebook.isPending ? (
          <Skeleton className="h-7 w-64" />
        ) : notebook.isSuccess ? (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="truncate text-2xl font-bold tracking-tight">
                {displayTitle(notebook.data.title)}
              </h1>
              <NotebookKindTag kind={notebook.data.kind} className="shrink-0" />
            </div>
            <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 text-sm">
              <span>
                Updated {timeAgo(notebook.data.updatedAt)} · {notebook.data.sourceCount}{' '}
                {notebook.data.sourceCount === 1 ? 'source' : 'sources'}
              </span>
              {notebook.data.learningPathId && (
                <Link
                  href={`/learn/${notebook.data.learningPathId}`}
                  className="text-primary inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                >
                  <GraduationCap className="size-4" aria-hidden />
                  View path
                </Link>
              )}
            </p>
          </div>
        ) : null}
      </div>

      {notebook.isPending ? null : notebook.isError ? (
        <div className="mt-6 rounded-xl border p-8 text-center">
          <p className="font-medium">
            {isApiError(notebook.error) && notebook.error.code === 'NOT_FOUND'
              ? 'Notebook not found.'
              : 'Couldn’t load this notebook.'}
          </p>
        </div>
      ) : (
        // Sources beside the chat on wide screens; stacked, chat first, on narrow ones.
        <div className="mt-4 grid grid-cols-1 gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="order-2 lg:order-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <SourcesPanel notebookId={notebookId} />
          </div>
          {/* On a phone the chat is one screen tall (minus the site header and title row) */}
          <div className="order-1 h-[calc(100dvh-10rem)] min-h-[24rem] lg:order-2 lg:h-auto lg:min-h-0">
            <ChatPanel notebookId={notebookId} />
          </div>
        </div>
      )}
    </main>
  );
}
