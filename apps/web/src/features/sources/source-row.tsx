'use client';

import type { Source, SourceStatus, SourceType } from '@curio/shared';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  StickyNote,
  Trash2,
  SquarePlay,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from 'cn';
import { canReprocessSource, canViewSource } from './viewer';

const typeIcons: Record<SourceType, ReactNode> = {
  PDF: <FileText />,
  WEBSITE: <Globe />,
  YOUTUBE: <SquarePlay />,
  TEXT: <StickyNote />,
};

const typeLabels: Record<SourceType, string> = {
  PDF: 'PDF',
  WEBSITE: 'Website',
  YOUTUBE: 'YouTube',
  TEXT: 'Text',
};

export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  switch (status) {
    case 'PENDING':
      return (
        <Badge variant="outline">
          <Clock />
          Pending
        </Badge>
      );
    case 'PROCESSING':
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" />
          Processing
        </Badge>
      );
    case 'READY':
      return (
        <Badge variant="success">
          <CheckCircle2 />
          Ready
        </Badge>
      );
    case 'FAILED':
      return (
        <Badge variant="destructive">
          <AlertCircle />
          Failed
        </Badge>
      );
  }
}

/** "example.com/articles/rag" for web sources; the type for the rest. */
function subtitle(source: Source): string {
  if (source.url && source.type === 'WEBSITE') {
    try {
      const url = new URL(source.url);
      return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return source.url;
    }
  }
  return typeLabels[source.type];
}

interface SourceRowProps {
  source: Source;
  highlighted: boolean;
  /** True while this source's retry request is in flight. */
  retrying: boolean;
  onOpenFile: () => void;
  onView: () => void;
  onReprocess: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function SourceRow({
  source,
  highlighted,
  retrying,
  onOpenFile,
  onView,
  onReprocess,
  onRename,
  onDelete,
}: SourceRowProps) {
  return (
    <li
      id={`source-${source.id}`}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-700',
        highlighted && 'border-primary bg-primary/5',
      )}
    >
      <span className="text-muted-foreground mt-0.5 [&_svg]:size-4" aria-hidden>
        {typeIcons[source.type]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-sm font-medium" title={source.title}>
            {source.title}
          </p>
          <SourceStatusBadge status={source.status} />
        </div>
        <p className="text-muted-foreground truncate text-xs">{subtitle(source)}</p>
        {source.status === 'FAILED' && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-destructive text-xs">
              {source.errorMessage ?? 'This source could not be processed.'}
            </p>
            <Button variant="outline" size="xs" disabled={retrying} onClick={onReprocess}>
              <RefreshCw className={cn(retrying && 'animate-spin')} />
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="-my-1 shrink-0"
              aria-label={`Actions for ${source.title}`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canViewSource(source) && (
            <DropdownMenuItem onClick={onView}>
              <Eye />
              View text and chunks
            </DropdownMenuItem>
          )}
          {source.type === 'PDF' && (
            <DropdownMenuItem onClick={onOpenFile}>
              <ExternalLink />
              Open PDF
            </DropdownMenuItem>
          )}
          {source.url && source.type !== 'PDF' && (
            <DropdownMenuItem
              onClick={() => window.open(source.url ?? undefined, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink />
              Open link
            </DropdownMenuItem>
          )}
          {canReprocessSource(source) && (
            <DropdownMenuItem disabled={retrying} onClick={onReprocess}>
              <RefreshCw />
              {source.status === 'FAILED' ? 'Retry' : 'Process again'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onRename}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
