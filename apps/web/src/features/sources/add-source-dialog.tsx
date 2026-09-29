'use client';

import { createSourceSchema, SOURCE_TITLE_MAX, type SourceType } from '@curio/shared';
import { FileText, Globe, StickyNote, SquarePlay } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { isApiError } from '@/lib/api';
import { cn } from 'cn';
import { useAddSource, useUploadPdf, type PdfUploadStage } from './queries';
import { UploadError, titleAfterFileChange } from './upload';

interface AddSourceDialogProps {
  notebookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the existing source's ID when the API reports a duplicate. */
  onDuplicate: (existingSourceId: string) => void;
}

const tabs: { type: SourceType; label: string; icon: ReactNode }[] = [
  { type: 'PDF', label: 'PDF', icon: <FileText /> },
  { type: 'WEBSITE', label: 'Website', icon: <Globe /> },
  { type: 'YOUTUBE', label: 'YouTube', icon: <SquarePlay /> },
  { type: 'TEXT', label: 'Text', icon: <StickyNote /> },
];

export function AddSourceDialog(props: AddSourceDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so every open starts fresh and closing cancels an upload */}
        {props.open && <AddSourceForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

interface FormError {
  message: string;
  field?: string;
  existingSourceId?: string;
}

/** Turns any failure into a message; field errors come from the API's `details`. */
function toFormError(err: unknown): FormError {
  if (isApiError(err)) {
    if (err.code === 'DUPLICATE_SOURCE') {
      return { message: err.message, existingSourceId: err.details?.existingSourceId };
    }
    const [field, message] = Object.entries(err.details ?? {})[0] ?? [];
    if (field && message) return { message, field };
    return { message: err.message };
  }
  if (err instanceof UploadError) return { message: err.message };
  return { message: 'Something went wrong. Please try again.' };
}

function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === 'AbortError';
}

const stageLabels: Record<PdfUploadStage, string> = {
  hashing: 'Reading file…',
  uploading: 'Uploading…',
  registering: 'Adding to notebook…',
};

function AddSourceForm({ notebookId, onOpenChange, onDuplicate }: AddSourceDialogProps) {
  const [type, setType] = useState<SourceType>('PDF');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  /** The title we filled in from the file name; replaced when the file changes unless edited. */
  const [autoTitle, setAutoTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<PdfUploadStage | null>(null);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const addSource = useAddSource(notebookId);
  const uploadPdf = useUploadPdf(notebookId);

  // Closing the dialog unmounts the form: cancel any upload in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  function switchType(next: SourceType) {
    if (pending) return;
    setType(next);
    setError(null);
  }

  async function submitPdf() {
    if (!file) {
      setError({ message: 'Choose a PDF to upload.', field: 'file' });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(0);
    await uploadPdf.mutateAsync({
      file,
      title,
      signal: controller.signal,
      onStage: setStage,
      onProgress: setProgress,
    });
  }

  async function submitOther() {
    const body =
      type === 'TEXT' ? { type, title, content } : { type: type as 'WEBSITE' | 'YOUTUBE', url };
    const parsed = createSourceSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError({ message: issue?.message ?? 'Invalid input', field: issue?.path.join('.') });
      return false;
    }
    if (parsed.data.type === 'PDF') return false;
    await addSource.mutateAsync(parsed.data);
    return true;
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (type === 'PDF') {
        await submitPdf();
        if (!file) return;
      } else if (!(await submitOther())) {
        return;
      }
      onOpenChange(false);
    } catch (err) {
      if (isAbort(err)) return;
      setError(toFormError(err));
    } finally {
      setPending(false);
      setStage(null);
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);
  const formError =
    error && !['url', 'title', 'content', 'file'].includes(error.field ?? '') ? error : null;

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Add a source</DialogTitle>
        <DialogDescription>
          Sources are processed in the background. You can keep working while they’re added.
        </DialogDescription>
      </DialogHeader>

      <div
        role="tablist"
        aria-label="Source type"
        className="bg-muted grid grid-cols-4 gap-1 rounded-lg p-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.type}
            type="button"
            role="tab"
            aria-selected={type === tab.type}
            disabled={pending}
            onClick={() => switchType(tab.type)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 [&_svg]:size-4',
              type === tab.type
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {type === 'PDF' && (
        <div className="grid gap-4">
          <Field id="source-file" label="PDF file" error={fieldError('file')}>
            <Input
              id="source-file"
              type="file"
              accept="application/pdf,.pdf"
              disabled={pending}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                const next = titleAfterFileChange(title, autoTitle, chosen?.name ?? null);
                if (next !== null) {
                  setTitle(next);
                  setAutoTitle(next);
                }
                setError(null);
              }}
              aria-invalid={fieldError('file') ? true : undefined}
            />
          </Field>
          <Field id="source-title" label="Title" error={fieldError('title')}>
            <Input
              id="source-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={SOURCE_TITLE_MAX}
              placeholder="Defaults to the file name"
              disabled={pending}
            />
          </Field>
          {stage && (
            <div className="grid gap-1.5" aria-live="polite">
              <div className="text-muted-foreground flex justify-between text-xs">
                <span>{stageLabels[stage]}</span>
                {stage === 'uploading' && <span>{Math.round(progress * 100)}%</span>}
              </div>
              <div
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                className="bg-muted h-2 overflow-hidden rounded-full"
              >
                <div
                  className="bg-primary h-full transition-[width] duration-200"
                  style={{ width: `${stage === 'registering' ? 100 : progress * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {(type === 'WEBSITE' || type === 'YOUTUBE') && (
        <Field
          id="source-url"
          label={type === 'WEBSITE' ? 'Web page URL' : 'YouTube video URL'}
          error={fieldError('url')}
        >
          <Input
            id="source-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={
              type === 'WEBSITE'
                ? 'https://example.com/article'
                : 'https://www.youtube.com/watch?v=…'
            }
            autoFocus
            disabled={pending}
            aria-invalid={fieldError('url') ? true : undefined}
          />
        </Field>
      )}

      {type === 'TEXT' && (
        <div className="grid gap-4">
          <Field id="source-title" label="Title" error={fieldError('title')}>
            <Input
              id="source-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={SOURCE_TITLE_MAX}
              placeholder="e.g. Lecture notes"
              autoFocus
              disabled={pending}
              aria-invalid={fieldError('title') ? true : undefined}
            />
          </Field>
          <Field id="source-content" label="Text" error={fieldError('content')}>
            <Textarea
              id="source-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Paste your notes or any text"
              className="max-h-72"
              disabled={pending}
              aria-invalid={fieldError('content') ? true : undefined}
            />
            <p className="text-muted-foreground text-right text-xs">
              {content.length.toLocaleString('en-US')} characters
            </p>
          </Field>
        </div>
      )}

      {formError && (
        <div role="alert" className="text-destructive text-sm">
          {formError.message}{' '}
          {formError.existingSourceId && (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                if (formError.existingSourceId) onDuplicate(formError.existingSourceId);
                onOpenChange(false);
              }}
            >
              Show it
            </button>
          )}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add source'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
