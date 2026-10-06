'use client';

import type { Memory } from '@curio/shared';
import { Brain, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { displayTitle, timeAgo } from '@/lib/format';
import { groupMemories, KIND_LABELS } from './grouping';
import { ConfirmDeleteDialog, EditMemoryDialog, levelLabel } from './memory-dialogs';
import { useDeleteAllMemories, useDeleteMemory, useMemories, useUpdateMemory } from './queries';

type DialogState =
  | { type: 'edit'; memory: Memory }
  | { type: 'delete'; memory: Memory }
  | { type: 'deleteAll' }
  | null;

/** The memory page (PRD §5.8): what Curio remembers about the learner, to view, edit, delete. */
export function MemoriesView() {
  const memories = useMemories();
  const updateMemory = useUpdateMemory();
  const deleteMemory = useDeleteMemory();
  const deleteAll = useDeleteAllMemories();
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const items = memories.data ?? [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            What Curio remembers about you. It shapes how answers are explained, never what they
            say: facts always come from your sources.
          </p>
        </div>
        {items.length > 0 && (
          <Button variant="outline" onClick={() => setDialog({ type: 'deleteAll' })}>
            <Trash2 />
            Delete all
          </Button>
        )}
      </div>

      <section className="mt-6 space-y-8" aria-live="polite">
        {memories.isPending ? (
          <div className="space-y-3" aria-label="Loading">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : memories.isError ? (
          <div className="rounded-lg border p-6 text-center">
            <p className="text-sm font-medium">Couldn’t load your memories.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void memories.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center rounded-lg border p-10 text-center">
            <Brain className="text-muted-foreground size-8" aria-hidden />
            <p className="mt-3 font-medium">Nothing remembered yet</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              As you chat, Curio notes things you say about yourself, like how you like explanations
              or what you’re preparing for. They’ll show up here.
            </p>
          </div>
        ) : (
          groupMemories(items).map((group) => (
            <div key={group.key}>
              <h2 className="text-sm font-semibold">{displayTitle(group.title)}</h2>
              <ul className="mt-2 divide-y rounded-lg border">
                {group.memories.map((memory) => (
                  <li key={memory.id} className="flex items-start gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{KIND_LABELS[memory.kind]}</Badge>
                        <span className="text-muted-foreground text-xs">
                          {memory.originLabel} · {timeAgo(memory.updatedAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm break-words">
                        {memory.kind === 'LEVEL' && memory.level
                          ? levelLabel(memory.level)
                          : memory.content}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit memory"
                      onClick={() => setDialog({ type: 'edit', memory })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete memory"
                      onClick={() => setDialog({ type: 'delete', memory })}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <EditMemoryDialog
        memory={dialog?.type === 'edit' ? dialog.memory : null}
        onOpenChange={close}
        onSubmit={(input) =>
          dialog?.type === 'edit'
            ? updateMemory.mutateAsync({ id: dialog.memory.id, input })
            : Promise.resolve()
        }
      />
      <ConfirmDeleteDialog
        open={dialog?.type === 'delete'}
        onOpenChange={close}
        title="Delete this memory?"
        description="Curio won’t learn it again from past messages, only if you say it again later."
        onConfirm={() =>
          dialog?.type === 'delete' ? deleteMemory.mutateAsync(dialog.memory.id) : Promise.resolve()
        }
      />
      <ConfirmDeleteDialog
        open={dialog?.type === 'deleteAll'}
        onOpenChange={close}
        title="Delete all memories?"
        description="Curio forgets everything it remembers about you. Your notebooks and chats stay. This can’t be undone."
        onConfirm={() => deleteAll.mutateAsync()}
      />
    </main>
  );
}
