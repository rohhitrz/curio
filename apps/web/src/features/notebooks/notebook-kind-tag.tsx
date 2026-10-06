import type { Notebook } from '@curio/shared';
import { FileText, GraduationCap } from 'lucide-react';
import { cn } from '@/lib/utils';

/** What started the notebook: the learner's own sources, or a learning path. */
export const notebookKindLabel: Record<Notebook['kind'], string> = {
  SOURCE: 'Your sources',
  LEARNING: 'Learning path',
};

export function NotebookKindTag({
  kind,
  className,
}: {
  kind: Notebook['kind'];
  className?: string;
}) {
  const Icon = kind === 'LEARNING' ? GraduationCap : FileText;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium [&_svg]:size-3.5',
        kind === 'LEARNING'
          ? 'bg-tag-learning-bg text-tag-learning'
          : 'bg-secondary text-secondary-foreground',
        className,
      )}
    >
      <Icon aria-hidden />
      {notebookKindLabel[kind]}
    </span>
  );
}
