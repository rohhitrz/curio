import type { Metadata } from 'next';
import { PathView } from '@/features/learning/path-view';

export const metadata: Metadata = { title: 'Learning path · Curio' };

export default async function LearningPathPage({ params }: PageProps<'/learn/[pathId]'>) {
  const { pathId } = await params;
  return <PathView pathId={pathId} />;
}
