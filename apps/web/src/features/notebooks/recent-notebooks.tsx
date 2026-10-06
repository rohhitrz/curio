'use client';

import { GraduationCap, Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { displayTitle, timeAgo } from '@/lib/format';
import { NotebookKindTag } from './notebook-kind-tag';
import { useNotebooks } from './queries';

const SHOWN = 6;

/** The home page for a signed-in learner: the latest notebooks, tagged by how they started. */
export function RecentNotebooks() {
  const notebooks = useNotebooks();

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Pick up where you left off
          </h1>
          <p className="text-muted-foreground mt-2">
            Your latest notebooks. Ask them questions, or keep going with a lesson.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/learn" />}>
            <GraduationCap />
            Learn a topic
          </Button>
          <Button nativeButton={false} render={<Link href="/notebooks" />}>
            <Plus />
            New notebook
          </Button>
        </div>
      </div>

      <section className="mt-8" aria-label="Recent notebooks">
        {notebooks.isPending ? (
          <ul className="divide-y rounded-xl border">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="p-4">
                <Skeleton className="h-5 w-48" />
              </li>
            ))}
          </ul>
        ) : notebooks.isError ? (
          <p className="text-muted-foreground rounded-xl border p-6 text-sm">
            Couldn’t load your notebooks. Reload the page to try again.
          </p>
        ) : notebooks.data.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-12 text-center">
            <p className="font-medium">No notebooks yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Add your own sources to a notebook, or learn a topic and Curio gathers them for you.
            </p>
          </div>
        ) : (
          <>
            <ul className="bg-card divide-y rounded-xl border">
              {notebooks.data.slice(0, SHOWN).map((notebook) => (
                <li key={notebook.id} className="relative">
                  <Link
                    href={`/notebooks/${notebook.id}`}
                    className="hover:bg-accent/60 focus-visible:ring-ring flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors first:rounded-t-xl last:rounded-b-xl focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="text-heading min-w-0 flex-1 truncate font-semibold">
                      {displayTitle(notebook.title)}
                    </span>
                    <NotebookKindTag kind={notebook.kind} />
                    <span className="text-muted-foreground w-28 text-right text-sm max-sm:w-auto">
                      {timeAgo(notebook.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Link
                href="/notebooks"
                className="text-primary text-sm font-medium underline-offset-4 hover:underline"
              >
                All notebooks
              </Link>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
