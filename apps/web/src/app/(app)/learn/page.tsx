import type { Metadata } from 'next';
import { LearnView } from '@/features/learning/learn-view';

export const metadata: Metadata = { title: 'Learn a topic · Curio' };

export default function LearnPage() {
  return <LearnView />;
}
