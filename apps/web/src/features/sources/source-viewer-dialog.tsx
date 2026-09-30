'use client';

import type { Source, SourceChunk } from '@curio/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from 'cn';
import { useSourceChunks, useSourceContent } from './queries';
import { chunkLocation, splitForHighlight, type HighlightRange } from './viewer';

type ViewerTab = 'text' | 'chunks';

interface SourceViewerDialogProps {
  /** The source being viewed; null closes the dialog. */
  source: Source | null;
  onOpenChange: (open: boolean) => void;
}

export function SourceViewerDialog({ source, onOpenChange }: SourceViewerDialogProps) {
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {/* Keyed by source, so the tab and highlight start fresh for each one */}
        {source && <SourceViewer key={source.id} source={source} />}
      </DialogContent>
    </Dialog>
  );
}

function SourceViewer({ source }: { source: Source }) {
  const [tab, setTab] = useState<ViewerTab>('text');
  const [highlight, setHighlight] = useState<HighlightRange | null>(null);

  function showInText(chunk: SourceChunk) {
    if (chunk.charStart === null || chunk.charEnd === null) return;
    setHighlight({ start: chunk.charStart, end: chunk.charEnd });
    setTab('text');
  }

  const tabs: { id: ViewerTab; label: string }[] = [
    { id: 'text', label: 'Text' },
    { id: 'chunks', label: `Chunks (${source.chunkCount})` },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle className="truncate pr-8">{source.title}</DialogTitle>
        <DialogDescription>
          The text Curio read from this source, and the passages it searches when you ask a
          question.
        </DialogDescription>
      </DialogHeader>

      <div
        role="tablist"
        aria-label="Source view"
        className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1"
      >
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`source-viewer-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`source-viewer-panel-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              'rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
              tab === id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`source-viewer-panel-${tab}`}
        aria-labelledby={`source-viewer-tab-${tab}`}
        className="min-w-0"
      >
        {tab === 'text' ? (
          <TextPanel sourceId={source.id} highlight={highlight} />
        ) : (
          <ChunksPanel sourceId={source.id} onShowInText={showInText} />
        )}
      </div>
    </div>
  );
}

const panelClass = 'max-h-[60vh] overflow-y-auto rounded-lg border';

function PanelSkeleton() {
  return (
    <div className="space-y-2" aria-label="Loading">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-10 rounded-lg" />
      ))}
    </div>
  );
}

function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border p-6 text-center">
      <p role="alert" className="text-destructive text-sm">
        {message}
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function TextPanel({
  sourceId,
  highlight,
}: {
  sourceId: string;
  highlight: HighlightRange | null;
}) {
  const content = useSourceContent(sourceId);
  const markRef = useRef<HTMLElement>(null);
  const text = content.data ?? '';
  const parts = splitForHighlight(text, highlight);

  // Bring the highlighted passage into view once the text is on screen.
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center' });
  }, [parts?.match, content.isSuccess]);

  if (content.isPending) return <PanelSkeleton />;
  if (content.isError) {
    return <PanelError message={content.error.message} onRetry={() => void content.refetch()} />;
  }
  if (text === '') {
    return <p className="text-muted-foreground text-sm">This source has no text yet.</p>;
  }

  return (
    <div className={cn(panelClass, 'p-4')}>
      {/* `pre-wrap` keeps the source's own line breaks; long URLs still wrap */}
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {parts ? (
          <>
            {parts.before}
            <mark ref={markRef} className="bg-primary/15 text-foreground rounded-sm px-0.5">
              {parts.match}
            </mark>
            {parts.after}
          </>
        ) : (
          text
        )}
      </p>
    </div>
  );
}

function ChunksPanel({
  sourceId,
  onShowInText,
}: {
  sourceId: string;
  onShowInText: (chunk: SourceChunk) => void;
}) {
  const chunks = useSourceChunks(sourceId);

  if (chunks.isPending) return <PanelSkeleton />;
  if (chunks.isError) {
    return <PanelError message={chunks.error.message} onRetry={() => void chunks.refetch()} />;
  }
  if (chunks.data.length === 0) {
    return <p className="text-muted-foreground text-sm">This source has no chunks yet.</p>;
  }

  return (
    <div className={cn(panelClass, 'p-2')}>
      <ol className="space-y-2">
        {chunks.data.map((chunk) => {
          const location = chunkLocation(chunk);
          const canShow = chunk.charStart !== null && chunk.charEnd !== null;
          return (
            <li key={chunk.id} className="rounded-md border p-3">
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="text-foreground font-medium tabular-nums">
                  #{chunk.chunkIndex + 1}
                </span>
                {location && <span className="min-w-0 truncate">{location}</span>}
                <span className="tabular-nums">{chunk.tokenCount} tokens</span>
                {canShow && (
                  <button
                    type="button"
                    className="text-foreground ml-auto underline underline-offset-2"
                    onClick={() => onShowInText(chunk)}
                  >
                    Show in text
                  </button>
                )}
              </div>
              <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
                {chunk.content}
              </p>
            </li>
          );
        })}
      </ol>
      {chunks.hasNextPage && (
        <div className="p-2 text-center">
          <Button
            variant="outline"
            size="sm"
            disabled={chunks.isFetchingNextPage}
            onClick={() => void chunks.fetchNextPage()}
          >
            {chunks.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
