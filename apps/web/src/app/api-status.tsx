'use client';

import { useQuery } from '@tanstack/react-query';
import { useApi } from './providers';

/** A dot beside the logo: green when the API answers, red when it doesn't. */
export function ApiStatus() {
  const api = useApi();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    refetchInterval: 60_000,
  });

  const label = health.isPending
    ? 'Checking the API'
    : health.isSuccess
      ? 'API online'
      : 'API offline';
  const dot = health.isPending
    ? 'bg-muted-foreground/50'
    : health.isSuccess
      ? 'bg-emerald-500'
      : 'bg-red-500';

  return (
    <span role="status" title={label} className="inline-flex size-4 items-center justify-center">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
