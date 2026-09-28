'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useNotebook } from './queries';

export function NotebookDetailView({ notebookId }: { notebookId: string }) {
  const notebook = useNotebook(notebookId);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
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
            Updated {timeAgo(notebook.data.updatedAt)} · {notebook.data.sourceCount} sources
          </p>
          <div className="text-muted-foreground mt-8 rounded-xl border border-dashed px-6 py-12 text-center text-sm">
            Adding sources arrives in Phase 2.
          </div>
        </>
      )}
    </main>
  );
}
