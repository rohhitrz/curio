'use client';

import { topicNameSchema, type Goal, type Level, type ScopeResponse } from '@curio/shared';
import { Compass, GraduationCap, Loader2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isApiError } from '@/lib/api';
import { GOAL_OPTIONS, LEVEL_OPTIONS, prefillNote } from './display';
import { OptionGroup } from './option-group';
import { usePrefill, useScopeCheck, useStartPath } from './queries';

/** The topic as typed, settled for `ms` before it is looked up. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The clarify screen (PRD §5.6 step 1): topic, level, goal. A level confirmed before, for this
 * topic or a related one, is pre-selected with a note; the learner confirms it by starting. A
 * topic too broad for one path gets narrower ones to pick from first (L-11); keeping it is fine.
 */
export function LearnView() {
  const router = useRouter();
  const startPath = useStartPath();
  const [topic, setTopic] = useState('');
  const [level, setLevel] = useState<Level | null>(null);
  const [levelTouched, setLevelTouched] = useState(false);
  const [goal, setGoal] = useState<Goal | null>(null);
  const scopeCheck = useScopeCheck();
  /** Narrower topics offered for this exact topic + level; cleared when either changes. */
  const [scope, setScope] = useState<(ScopeResponse & { topic: string; level: Level }) | null>(
    null,
  );

  const parsedTopic = topicNameSchema.safeParse(topic);
  const settledTopic = useSettled(parsedTopic.success ? parsedTopic.data : '', 500);
  const prefill = usePrefill(settledTopic);
  const match = settledTopic ? (prefill.data ?? null) : null;

  // Pre-select the remembered level until the learner picks one themselves.
  useEffect(() => {
    if (!levelTouched) setLevel(match?.level ?? null);
  }, [match, levelTouched]);

  const busy = startPath.isPending || scopeCheck.isPending;
  const canStart = parsedTopic.success && level !== null && goal !== null && !busy;
  const offered =
    scope && parsedTopic.success && scope.topic === parsedTopic.data && scope.level === level
      ? scope
      : null;

  const start = (chosenTopic: string) => {
    if (!level || !goal) return;
    startPath.mutate(
      { topic: chosenTopic, level, goal },
      { onSuccess: (started) => router.push(`/learn/${started.pathId}`) },
    );
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!parsedTopic.success || !level || !goal) return;
    const chosen = parsedTopic.data;
    // Options already shown for this topic: building now means keeping it.
    if (offered) {
      start(chosen);
      return;
    }
    scopeCheck.mutate(
      { topic: chosen, level },
      {
        onSuccess: (result) => {
          if (result.broad) setScope({ ...result, topic: chosen, level });
          else start(chosen);
        },
        // A suggestion only: never in the way of starting.
        onError: () => start(chosen),
      },
    );
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-10">
      <div className="flex items-center gap-3">
        <GraduationCap className="text-muted-foreground size-7" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">Learn a topic</h1>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        Curio finds the official docs and the best-known resources, maps what they all teach, and
        builds a path for your level. Everything in it is backed by those sources.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-6">
        <div className="space-y-2">
          <Label htmlFor="topic">What do you want to learn?</Label>
          <Input
            id="topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. Machine learning, The French Revolution, Kubernetes"
            autoComplete="off"
            autoFocus
            disabled={busy}
          />
        </div>

        <div className="space-y-2">
          <OptionGroup
            legend="Your level"
            name="level"
            options={LEVEL_OPTIONS}
            value={level}
            onChange={(value) => {
              setLevel(value);
              setLevelTouched(true);
            }}
            disabled={busy}
          />
          {match && !levelTouched && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm" role="status">
              <Sparkles className="size-4 shrink-0" aria-hidden />
              {prefillNote(match)}
            </p>
          )}
        </div>

        <OptionGroup
          legend="What’s it for?"
          name="goal"
          options={GOAL_OPTIONS}
          value={goal}
          onChange={setGoal}
          disabled={busy}
        />

        {offered && (
          <div className="bg-muted/30 rounded-xl border p-4" role="status">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Compass className="text-muted-foreground size-4 shrink-0" aria-hidden />
              {offered.question ?? 'That’s a big topic. Which part do you want to start with?'}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              A focused topic makes a deeper path. Pick one, or keep yours.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {offered.options.map((option) => (
                <Button
                  key={option.topic}
                  type="button"
                  variant="outline"
                  size="sm"
                  title={option.topic}
                  disabled={busy}
                  onClick={() => {
                    setTopic(option.topic);
                    start(option.topic);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {startPath.isError && (
          <p className="text-destructive text-sm" role="alert">
            {isApiError(startPath.error)
              ? startPath.error.message
              : 'Couldn’t start the path. Please try again.'}
          </p>
        )}

        <Button type="submit" disabled={!canStart}>
          {busy && <Loader2 className="animate-spin" />}
          {offered ? `Keep “${offered.topic}”` : 'Build my path'}
        </Button>
      </form>
    </main>
  );
}
