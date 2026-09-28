'use client';

import { createNotebookSchema, NOTEBOOK_TITLE_MAX } from '@curio/shared';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isApiError } from '@/lib/api';

interface NotebookTitleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'rename';
  initialTitle?: string;
  onSubmit: (title: string) => Promise<unknown>;
}

const copy = {
  create: {
    title: 'New notebook',
    description: 'Give it a name. You can add sources after it’s created.',
    submit: 'Create',
    pending: 'Creating…',
  },
  rename: {
    title: 'Rename notebook',
    description: 'Choose a new name for this notebook.',
    submit: 'Save',
    pending: 'Saving…',
  },
};

export function NotebookTitleDialog(props: NotebookTitleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {/* Keyed so the form resets each time the dialog opens */}
        {props.open && <TitleForm key={props.initialTitle ?? ''} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function TitleForm({ mode, initialTitle = '', onSubmit, onOpenChange }: NotebookTitleDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const text = copy[mode];

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createNotebookSchema.safeParse({ title });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(parsed.data.title);
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
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="notebook-title">Title</Label>
        <Input
          id="notebook-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={NOTEBOOK_TITLE_MAX}
          placeholder="e.g. Organic chemistry"
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'notebook-title-error' : undefined}
        />
        {error && (
          <p id="notebook-title-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? text.pending : text.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}
