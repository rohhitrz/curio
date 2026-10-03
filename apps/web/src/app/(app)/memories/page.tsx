import type { Metadata } from 'next';
import { MemoriesView } from '@/features/memories/memories-view';

export const metadata: Metadata = { title: 'Memory · Curio' };

export default function MemoriesPage() {
  return <MemoriesView />;
}
