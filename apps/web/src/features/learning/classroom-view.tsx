'use client';

import type { Outline, OutlineModule } from '@curio/shared';
import { ArrowLeft, BookOpen, CircleCheck, ExternalLink, GraduationCap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCitationOpener } from '@/features/chat/use-citation-opener';
import { isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { classroomHref, firstModuleToLearn } from './display';
import { LessonPanel } from './lesson-panel';
import { useLesson, useOutline, usePath } from './queries';
import { TutorPanel } from './tutor-panel';
import { useLessonStream } from './use-lesson-stream';

/**
 * The classroom (PRD §5.6 step 8, decision L-10): the path's modules on one side, the open
 * module's lesson and its tutor on the other. Phones switch between the lesson and the tutor.
 */
export function ClassroomView({ pathId, moduleId }: { pathId: string; moduleId: string | null }) {
  const path = usePath(pathId);
  const outline = useOutline(pathId, path.data?.status === 'READY');

  return (
    // Fills the window under the site header on wide screens, so each column scrolls alone.
    <main className="mx-auto flex max-w-[90rem] flex-col px-4 py-4 lg:h-[calc(100dvh-3.5rem-1px)]">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Back to the path"
          nativeButton={false}
          render={<Link href={`/learn/${pathId}`} />}
        >
          <ArrowLeft />
        </Button>
        {path.isSuccess ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <h1 className="truncate text-xl font-semibold tracking-tight">{path.data.topic}</h1>
            {outline.isSuccess && (
              <p className="text-muted-foreground text-sm">
                {outline.data.progress.completed} of {outline.data.progress.enabled} modules done
              </p>
            )}
          </div>
        ) : (
          <Skeleton className="h-7 w-64" />
        )}
      </div>

      {path.isError || outline.isError ? (
        <div className="mt-6 rounded-xl border p-8 text-center">
          <p className="font-medium">
            {isApiError(path.error) && path.error.code === 'NOT_FOUND'
              ? 'Learning path not found.'
              : 'Couldn’t load this path.'}
          </p>
        </div>
      ) : path.isSuccess && path.data.status !== 'READY' ? (
        <div className="mt-6 rounded-xl border p-8 text-center">
          <p className="font-medium">This path isn’t ready yet.</p>
          <Button className="mt-4" nativeButton={false} render={<Link href={`/learn/${pathId}`} />}>
            See its progress
          </Button>
        </div>
      ) : outline.isSuccess && path.isSuccess ? (
        <Classroom
          pathId={pathId}
          notebookId={path.data.notebookId}
          outline={outline.data}
          moduleId={moduleId}
        />
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[15rem_1fr]" aria-label="Loading">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      )}
    </main>
  );
}

function Classroom({
  pathId,
  notebookId,
  outline,
  moduleId,
}: {
  pathId: string;
  notebookId: string;
  outline: Outline;
  moduleId: string | null;
}) {
  const router = useRouter();
  const stream = useLessonStream(pathId);
  const [notice, setNotice] = useState<string | null>(null);
  const citations = useCitationOpener(notebookId, setNotice);
  const [tab, setTab] = useState<'lesson' | 'tutor'>('lesson');

  const modules = outline.modules.filter((m) => m.isEnabled);
  const selectedId = modules.some((m) => m.id === moduleId)
    ? moduleId
    : firstModuleToLearn(outline.modules);
  const module = outline.modules.find((m) => m.id === selectedId) ?? null;
  const lesson = useLesson(module?.id ?? null);
  const next = module ? modules[modules.indexOf(module) + 1] : undefined;

  const open = (id: string) => {
    setNotice(null);
    setTab('lesson');
    router.replace(classroomHref(pathId, id), { scroll: false });
  };
  const cite = (citation: Parameters<typeof citations.open>[0]) => {
    setNotice(null);
    citations.open(citation);
  };

  if (!module) {
    return (
      <div className="mt-6 rounded-xl border p-8 text-center">
        <p className="font-medium">No modules are turned on.</p>
        <Button className="mt-4" nativeButton={false} render={<Link href={`/learn/${pathId}`} />}>
          Choose modules
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,24rem)]">
      {/* Modules: a list on wide screens, a picker on phones. */}
      <nav aria-label="Modules" className="lg:min-h-0 lg:overflow-y-auto">
        <label className="lg:hidden">
          <span className="sr-only">Module</span>
          <select
            value={module.id}
            onChange={(event) => open(event.target.value)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm"
          >
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.position}. {m.title}
                {m.completedAt ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </label>
        <ol className="hidden space-y-1 lg:block">
          {modules.map((m) => (
            <ModuleItem key={m.id} module={m} active={m.id === module.id} onOpen={open} />
          ))}
        </ol>
        <TeacherStudied outline={outline} notebookId={notebookId} />
      </nav>

      <div className="flex gap-2 lg:hidden" role="tablist" aria-label="Lesson or tutor">
        {(['lesson', 'tutor'] as const).map((value) => (
          <Button
            key={value}
            role="tab"
            aria-selected={tab === value}
            variant={tab === value ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab(value)}
          >
            {value === 'lesson' ? <BookOpen /> : <GraduationCap />}
            {value === 'lesson' ? 'Lesson' : 'Tutor'}
          </Button>
        ))}
      </div>

      <section
        aria-label="Lesson"
        className={cn(
          'rounded-xl border p-5 sm:p-8 lg:block lg:min-h-0 lg:overflow-y-auto',
          tab !== 'lesson' && 'hidden',
        )}
      >
        {notice && (
          <p role="alert" className="text-destructive mb-4 text-sm">
            {notice}
          </p>
        )}
        <LessonPanel
          key={module.id}
          pathId={pathId}
          module={module}
          stream={stream}
          onCite={cite}
          onNext={next ? () => open(next.id) : null}
        />
      </section>

      <div
        className={cn(
          'h-[calc(100dvh-12rem)] min-h-[24rem] lg:block lg:h-auto lg:min-h-0',
          tab !== 'tutor' && 'hidden',
        )}
      >
        <TutorPanel
          pathId={pathId}
          notebookId={notebookId}
          moduleId={module.id}
          moduleTitle={module.title}
          done={module.completedAt !== null}
          lesson={lesson.data ?? null}
          onCite={cite}
        />
      </div>
      {citations.viewer}
    </div>
  );
}

function ModuleItem({
  module,
  active,
  onOpen,
}: {
  module: OutlineModule;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(module.id)}
        aria-current={active ? 'step' : undefined}
        className={cn(
          'hover:bg-muted/60 flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
          active && 'bg-muted font-medium',
        )}
      >
        <span className="text-muted-foreground w-5 shrink-0 tabular-nums">{module.position}.</span>
        <span className="min-w-0 flex-1">{module.title}</span>
        {module.completedAt && (
          <CircleCheck className="text-primary mt-0.5 size-4 shrink-0" aria-label="Done" />
        )}
      </button>
    </li>
  );
}

/** The resources, out of the way: Curio studied them so the learner doesn't have to. */
function TeacherStudied({ outline, notebookId }: { outline: Outline; notebookId: string }) {
  return (
    <details className="mt-4 rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">What your teacher studied</summary>
      <p className="text-muted-foreground mt-2 text-xs">
        Read in full; lessons and your tutor cite them. Also in the{' '}
        <Link href={`/notebooks/${notebookId}`} className="underline underline-offset-2">
          notebook
        </Link>
        .
      </p>
      <ul className="mt-2 space-y-2">
        {outline.resources.map((resource) => (
          <li key={resource.id} className="flex items-center gap-2">
            {resource.role === 'OFFICIAL' && <Badge>Official</Badge>}
            <span className="min-w-0 flex-1 truncate text-xs">{resource.title}</span>
            <a
              href={resource.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Open ${resource.title}`}
            >
              <ExternalLink className="size-3.5" />
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
