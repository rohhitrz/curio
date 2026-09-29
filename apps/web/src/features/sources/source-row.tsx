'use client';

import type { Source, SourceStatus, SourceType } from '@curio/shared';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  MoreHorizontal,
  Pencil,
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
  onOpenFile: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function SourceRow({ source, highlighted, onOpenFile, onRename, onDelete }: SourceRowProps) {
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
        {source.status === 'FAILED' && source.errorMessage && (
          <p className="text-destructive mt-1 text-xs">{source.errorMessage}</p>
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
