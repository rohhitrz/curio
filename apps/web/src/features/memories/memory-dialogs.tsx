'use client';

import {
  MEMORY_CONTENT_MAX,
  levelSchema,
  updateMemorySchema,
  type Level,
  type Memory,
  type UpdateMemoryInput,
} from '@curio/shared';
import { useState, type SyntheticEvent } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { isApiError } from '@/lib/api';

const LEVEL_LABELS: Record<Level, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
};

export const levelLabel = (level: Level) => LEVEL_LABELS[level];

interface EditMemoryDialogProps {
  memory: Memory | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: UpdateMemoryInput) => Promise<unknown>;
}

/** Edits the text, or the level of a level memory. Saving makes it the user's own. */
export function EditMemoryDialog({ memory, onOpenChange, onSubmit }: EditMemoryDialogProps) {
  return (
    <Dialog open={memory !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {memory && (
          <EditForm
            key={memory.id}
            memory={memory}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ memory, onOpenChange, onSubmit }: EditMemoryDialogProps & { memory: Memory }) {
  const isLevel = memory.kind === 'LEVEL';
  const [content, setContent] = useState(memory.content);
  const [level, setLevel] = useState<Level>(memory.level ?? 'BEGINNER');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = updateMemorySchema.safeParse(isLevel ? { level } : { content });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid memory');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(parsed.data);
      onOpenChange(false);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{isLevel ? 'Change your level' : 'Edit memory'}</DialogTitle>
        <DialogDescription>
          Curio uses this to adjust how it explains things. Your edits are never overwritten.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        {isLevel ? (
          <>
            <Label htmlFor="memory-level">
              Level{memory.topic ? ` in ${memory.topic.name}` : ''}
            </Label>
            <select
              id="memory-level"
              value={level}
              onChange={(event) => setLevel(levelSchema.parse(event.target.value))}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              {levelSchema.options.map((option) => (
                <option key={option} value={option}>
                  {LEVEL_LABELS[option]}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <Label htmlFor="memory-content">Memory</Label>
            <Textarea
              id="memory-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              maxLength={MEMORY_CONTENT_MAX}
              rows={3}
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'memory-error' : undefined}
            />
          </>
        )}
        {error && (
          <p id="memory-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => Promise<unknown>;
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Could not delete. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() => void handleConfirm()}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
