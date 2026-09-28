'use client';

import { useQuery } from '@tanstack/react-query';
import { useApi } from './providers';

export function ApiStatus() {
  const api = useApi();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health() });

  const label = health.isPending ? 'Checking…' : health.isSuccess ? 'API online' : 'API offline';
  const dot = health.isPending
    ? 'bg-muted-foreground'
    : health.isSuccess
      ? 'bg-emerald-500'
      : 'bg-destructive';

  return (
    <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </p>
  );
}
