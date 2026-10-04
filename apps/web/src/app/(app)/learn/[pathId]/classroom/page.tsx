import type { Metadata } from 'next';
import { ClassroomView } from '@/features/learning/classroom-view';

export const metadata: Metadata = { title: 'Classroom · Curio' };

export default async function ClassroomPage({
  params,
  searchParams,
}: PageProps<'/learn/[pathId]/classroom'>) {
  const { pathId } = await params;
  const { module } = await searchParams;
  return <ClassroomView pathId={pathId} moduleId={typeof module === 'string' ? module : null} />;
}
