import type { Metadata } from 'next';
import { NotebooksView } from '@/features/notebooks/notebooks-view';

export const metadata: Metadata = { title: 'Notebooks · Curio' };

export default function NotebooksPage() {
  return <NotebooksView />;
}
