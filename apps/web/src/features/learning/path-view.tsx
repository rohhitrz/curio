'use client';

import type { LearningPath, Outline } from '@curio/shared';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ExternalLink,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type SyntheticEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { GOAL_OPTIONS, LEVEL_OPTIONS, stageIndex, STAGES, whyHere } from './display';
import { useOutline, usePath, useRetryPath, useSelectBranch, useToggleModule } from './queries';

const errorMessage = (error: unknown, fallback: string) =>
  isApiError(error) ? error.message : fallback;

/** A learning path: progress while it is built, the branch pick, a failure, then the outline. */
export function PathView({ pathId }: { pathId: string }) {
  const path = usePath(pathId);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2"
        nativeButton={false}
        render={<Link href="/learn" />}
      >
        <ArrowLeft />
        Learn a topic
      </Button>

      {path.isPending ? (
        <div className="mt-4 space-y-3" aria-label="Loading">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : path.isError ? (
        <div className="mt-6 rounded-xl border p-8 text-center">
          <p className="font-medium">
            {isApiError(path.error) && path.error.code === 'NOT_FOUND'
              ? 'Learning path not found.'
              : 'Couldn’t load this path.'}
          </p>
        </div>
      ) : (
        <>
          <PathHeader path={path.data} />
          <section className="mt-6" aria-live="polite">
            {path.data.status === 'READY' ? (
              <OutlineSection path={path.data} />
            ) : path.data.status === 'FAILED' ? (
              <FailedPath path={path.data} />
            ) : path.data.status === 'AWAITING_BRANCH' && path.data.selectedBranch === null ? (
              <BranchPicker path={path.data} />
            ) : (
              <Progress path={path.data} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function PathHeader({ path }: { path: LearningPath }) {
  const level = LEVEL_OPTIONS.find((o) => o.value === path.level)?.label;
  const goal = GOAL_OPTIONS.find((o) => o.value === path.goal)?.label;
  return (
    <div className="mt-2">
      <h1 className="text-2xl font-semibold tracking-tight break-words">{path.topic}</h1>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge variant="secondary">{level}</Badge>
        <Badge variant="outline">For {goal?.toLowerCase()}</Badge>
        {path.selectedBranch && <Badge variant="outline">Branch: {path.selectedBranch}</Badge>}
      </div>
    </div>
  );
}

/** The job's stages, the current one spinning. Polled every ~2s (usePath). */
function Progress({ path }: { path: LearningPath }) {
  const current = stageIndex(path.status);
  return (
    <div className="rounded-xl border p-6">
      <p className="font-medium">Building your path…</p>
      <p className="text-muted-foreground mt-1 text-sm">
        This takes a few minutes. You can leave this page; the path keeps building.
      </p>
      <ol className="mt-5 space-y-3">
        {STAGES.map((stage, i) => (
          <li key={stage.status} className="flex items-center gap-3 text-sm">
            {i < current ? (
              <Check className="text-primary size-4 shrink-0" aria-hidden />
            ) : i === current ? (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : (
              <span className="border-muted-foreground/40 size-4 shrink-0 rounded-full border" />
            )}
            <span className={cn(i > current && 'text-muted-foreground')}>
              {stage.label}
              {i === current && <span className="sr-only"> (in progress)</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Advanced paths pause here (decision L-04): the learner picks the direction to go deep in. */
function BranchPicker({ path }: { path: LearningPath }) {
  const selectBranch = useSelectBranch();
  const [branch, setBranch] = useState<string | null>(null);
  const options = path.branchOptions ?? [];

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (branch) selectBranch.mutate({ pathId: path.id, branch });
  };

  return (
    <form onSubmit={submit} className="rounded-xl border p-6">
      <fieldset disabled={selectBranch.isPending}>
        <legend className="font-medium">Pick a branch to go deep in</legend>
        <p className="text-muted-foreground mt-1 text-sm">
          Your resources cover more than one direction. Choose one; the path covers it in depth.
        </p>
        <div className="mt-4 space-y-2">
          {options.map((option) => (
            <label
              key={option.name}
              className={cn(
                'hover:bg-muted/50 flex cursor-pointer flex-col rounded-lg border p-3 transition-colors',
                'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]',
                branch === option.name && 'border-primary bg-muted/50',
              )}
            >
              <input
                type="radio"
                name="branch"
                value={option.name}
                checked={branch === option.name}
                onChange={() => setBranch(option.name)}
                className="sr-only"
              />
              <span className="text-sm font-medium">{option.name}</span>
              <span className="text-muted-foreground mt-0.5 text-sm">{option.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {selectBranch.isError && (
        <p className="text-destructive mt-3 text-sm" role="alert">
          {errorMessage(selectBranch.error, 'Couldn’t save your pick. Please try again.')}
        </p>
      )}
      <Button type="submit" className="mt-4" disabled={!branch || selectBranch.isPending}>
        {selectBranch.isPending && <Loader2 className="animate-spin" />}
        Continue with this branch
      </Button>
    </form>
  );
}

function FailedPath({ path }: { path: LearningPath }) {
  const retry = useRetryPath();
  return (
    <div className="rounded-xl border p-6">
      <div className="flex items-start gap-3">
        <TriangleAlert className="text-destructive mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">This path couldn’t be built</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {path.error?.message ?? 'Something went wrong while building this path.'}
          </p>
        </div>
      </div>
      {retry.isError && (
        <p className="text-destructive mt-3 text-sm" role="alert">
          {errorMessage(retry.error, 'Couldn’t retry. Please try again.')}
        </p>
      )}
      <Button className="mt-4" onClick={() => retry.mutate(path.id)} disabled={retry.isPending}>
        {retry.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        Try again
      </Button>
      <p className="text-muted-foreground mt-2 text-xs">
        Resources already read are reused; a retry doesn’t count toward your daily limit.
      </p>
    </div>
  );
}

function OutlineSection({ path }: { path: LearningPath }) {
  const outline = useOutline(path.id, true);
  if (outline.isPending) {
    return (
      <div className="space-y-3" aria-label="Loading">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    );
  }
  if (outline.isError) {
    return (
      <div className="rounded-xl border p-6 text-center">
        <p className="text-sm font-medium">Couldn’t load the outline.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void outline.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return <OutlineContent path={path} outline={outline.data} />;
}

function OutlineContent({ path, outline }: { path: LearningPath; outline: Outline }) {
  const toggle = useToggleModule(path.id);
  const resourceCount = outline.resources.length;

  return (
    <div className="space-y-8">
      {outline.hook && (
        <div className="bg-muted/30 rounded-xl border p-6">
          <p className="text-lg leading-relaxed">{outline.hook.what}</p>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground font-medium">Why it matters</dt>
              <dd className="mt-1">{outline.hook.why}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground font-medium">In the real world</dt>
              <dd className="mt-1">{outline.hook.example}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground font-medium">Where it came from</dt>
              <dd className="mt-1">{outline.hook.origin}</dd>
            </div>
          </dl>
        </div>
      )}

      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Your path</h2>
            <p className="text-muted-foreground text-sm">
              {outline.progress.enabled} of {outline.modules.length} modules selected. Uncheck any
              you want to skip.
            </p>
          </div>
          <Button nativeButton={false} render={<Link href={`/notebooks/${path.notebookId}`} />}>
            <BookOpen />
            Start learning
          </Button>
        </div>
        {toggle.isError && (
          <p className="text-destructive mt-2 text-sm" role="alert">
            {errorMessage(toggle.error, 'Couldn’t change the module. Please try again.')}
          </p>
        )}
        <ol className="mt-4 space-y-3">
          {outline.modules.map((module) => (
            <li
              key={module.id}
              className={cn('rounded-xl border p-4', !module.isEnabled && 'opacity-60')}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`module-${module.id}`}
                  checked={module.isEnabled}
                  onChange={(event) =>
                    toggle.mutate({ moduleId: module.id, isEnabled: event.target.checked })
                  }
                  className="accent-primary mt-1 size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <label htmlFor={`module-${module.id}`} className="cursor-pointer font-medium">
                    {module.position}. {module.title}
                  </label>
                  <p className="text-muted-foreground mt-0.5 text-sm">{module.summary}</p>
                  <ul className="mt-3 space-y-1">
                    {module.concepts.map((concept) => (
                      <li key={concept.id}>
                        <details className="group text-sm">
                          <summary className="cursor-pointer list-none">
                            <span>{concept.name}</span>{' '}
                            <span className="text-muted-foreground text-xs underline-offset-2 group-open:hidden hover:underline">
                              why is this here?
                            </span>
                          </summary>
                          <p className="text-muted-foreground mt-1 mb-2 ml-3 text-xs">
                            {whyHere(concept, resourceCount)}
                          </p>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {outline.skipped.length > 0 && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">
            Skipped for now ({outline.skipped.length})
          </summary>
          <p className="text-muted-foreground mt-2 text-sm">
            Covered by your resources but left out at your level. Nothing is dropped silently.
          </p>
          <ul className="mt-3 space-y-2">
            {outline.skipped.map((item) => (
              <li key={item.name} className="text-sm">
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground"> · {item.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div>
        <h2 className="text-lg font-semibold">Resources</h2>
        <p className="text-muted-foreground text-sm">
          Read once and added to the path’s notebook; lessons and chat cite them.
        </p>
        <ul className="mt-3 divide-y rounded-xl border">
          {outline.resources.map((resource) => (
            <li key={resource.id} className="flex items-center gap-3 p-3 text-sm">
              <Badge variant={resource.role === 'OFFICIAL' ? 'default' : 'secondary'}>
                {resource.role === 'OFFICIAL' ? 'Official' : resource.type.toLowerCase()}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{resource.title}</span>
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Open ${resource.title}`}
              >
                <ExternalLink className="size-4" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
