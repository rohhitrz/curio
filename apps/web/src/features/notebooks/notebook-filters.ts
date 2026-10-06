import type { Notebook } from '@curio/shared';
import { notebookKindLabel } from './notebook-kind-tag';

export type KindFilter = 'ALL' | Notebook['kind'];

export const filters: { value: KindFilter; label: string; param: string | null }[] = [
  { value: 'ALL', label: 'All', param: null },
  { value: 'SOURCE', label: notebookKindLabel.SOURCE, param: 'sources' },
  { value: 'LEARNING', label: 'Learning paths', param: 'learning' },
];

/** `?show=sources` / `?show=learning`; anything else shows all. */
export function parseKindFilter(show: string | string[] | undefined): KindFilter {
  return filters.find((option) => option.param !== null && option.param === show)?.value ?? 'ALL';
}
