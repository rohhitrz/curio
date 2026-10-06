import type { Metadata } from 'next';
import { parseKindFilter } from '@/features/notebooks/notebook-filters';
import { NotebooksView } from '@/features/notebooks/notebooks-view';

export const metadata: Metadata = { title: 'Notebooks · Curio' };

export default async function NotebooksPage({ searchParams }: PageProps<'/notebooks'>) {
  // The filter lives in the URL, so the browser's back button returns to it.
  const { show } = await searchParams;
  return <NotebooksView initialFilter={parseKindFilter(show)} />;
}
