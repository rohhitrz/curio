'use client';

import type { Notebook } from '@curio/shared';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { displayTitle, timeAgo } from '@/lib/format';
import { NotebookKindTag } from './notebook-kind-tag';

interface NotebookCardProps {
  notebook: Notebook;
  onRename: () => void;
  onDelete: () => void;
}

export function NotebookCard({ notebook, onRename, onDelete }: NotebookCardProps) {
  return (
    <Card className="hover:border-primary/40 has-focus-visible:ring-ring relative transition-colors has-focus-visible:ring-2">
      <CardHeader className="gap-3 pr-12">
        <CardTitle className="text-heading line-clamp-2 text-lg leading-snug break-words">
          <Link
            href={`/notebooks/${notebook.id}`}
            className="after:absolute after:inset-0 focus-visible:outline-none"
          >
            {displayTitle(notebook.title)}
          </Link>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <NotebookKindTag kind={notebook.kind} />
          <CardDescription>Updated {timeAgo(notebook.updatedAt)}</CardDescription>
        </div>
      </CardHeader>
      <div className="absolute top-3 right-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${displayTitle(notebook.title)}`}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
      </div>
    </Card>
  );
}
