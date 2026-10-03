'use client';

import { memoryListSchema, type Memory } from '@curio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/app/providers';
import { newlyNoted } from './grouping';
import { memoryKeys } from './queries';

/**
 * When to look for new memories after an answer: the extraction job runs in the background
 * (API doc §7), usually within seconds, and only once enough messages have piled up.
 */
const CHECK_DELAYS_MS = [6_000, 20_000];

/** Start a little in the past, so a client clock running ahead can't hide a new memory. */
const SINCE_MARGIN_MS = 60_000;

/**
 * The "Noted" notice: after each answer, asks `GET /memories?since=…` a couple of times and
 * collects memories newly noted from the chat. Failures are silent: the notice is a nicety.
 */
export function useNotedMemories() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [noted, setNoted] = useState<Memory[]>([]);
  const since = useRef(new Date(Date.now() - SINCE_MARGIN_MS).toISOString());
  const shown = useRef(new Set<string>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  async function check() {
    try {
      const { items } = await api.get('/memories', {
        query: { since: since.current },
        schema: memoryListSchema,
      });
      const result = newlyNoted(items, shown.current);
      if (result.latest) since.current = result.latest;
      if (result.noted.length === 0) return;
      for (const memory of result.noted) shown.current.add(memory.id);
      setNoted((current) => [...current, ...result.noted]);
      await queryClient.invalidateQueries({ queryKey: memoryKeys.list() });
    } catch {
      // Not worth bothering the user about; the memory page shows everything.
    }
  }

  return {
    noted,
    /** Call when an answer has finished. */
    afterAnswer() {
      timers.current.forEach(clearTimeout);
      timers.current = CHECK_DELAYS_MS.map((delay) => setTimeout(() => void check(), delay));
    },
    dismiss: () => setNoted([]),
  };
}
