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
import { timeAgo } from '@/lib/format';

interface NotebookCardProps {
  notebook: Notebook;
  onRename: () => void;
  onDelete: () => void;
}

export function NotebookCard({ notebook, onRename, onDelete }: NotebookCardProps) {
  return (
    <Card className="hover:bg-muted/40 relative transition-colors">
      <CardHeader className="pr-12">
        <CardTitle className="line-clamp-2 break-words">
          <Link
            href={`/notebooks/${notebook.id}`}
            className="after:absolute after:inset-0 focus-visible:outline-none"
          >
            {notebook.title}
          </Link>
        </CardTitle>
        <CardDescription>Updated {timeAgo(notebook.updatedAt)}</CardDescription>
      </CardHeader>
      <div className="absolute top-3 right-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon" aria-label={`Actions for ${notebook.title}`} />
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
