'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api';
import { ChatPanel } from '@/features/chat/chat-panel';
import { SourcesPanel } from '@/features/sources/sources-panel';
import { timeAgo } from '@/lib/format';
import { useNotebook } from './queries';

export function NotebookDetailView({ notebookId }: { notebookId: string }) {
  const notebook = useNotebook(notebookId);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/notebooks" />}>
        <ArrowLeft />
        Notebooks
      </Button>

      {notebook.isPending ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : notebook.isError ? (
        <div className="mt-6 rounded-xl border p-8 text-center">
          <p className="font-medium">
            {isApiError(notebook.error) && notebook.error.code === 'NOT_FOUND'
              ? 'Notebook not found.'
              : 'Couldn’t load this notebook.'}
          </p>
        </div>
      ) : (
        <>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight break-words">
            {notebook.data.title}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Updated {timeAgo(notebook.data.updatedAt)} · {notebook.data.sourceCount}{' '}
            {notebook.data.sourceCount === 1 ? 'source' : 'sources'}
          </p>
          {/* Sources beside the chat on wide screens; stacked, chat first, on narrow ones */}
          <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
            <div className="order-2 lg:order-1">
              <SourcesPanel notebookId={notebookId} />
            </div>
            <div className="order-1 mt-6 lg:sticky lg:top-6 lg:order-2 lg:mt-8">
              <ChatPanel notebookId={notebookId} />
            </div>
          </div>
        </>
      )}
    </main>
  );
}
