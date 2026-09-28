import { NotebookDetailView } from '@/features/notebooks/notebook-detail-view';

export default async function NotebookPage({ params }: PageProps<'/notebooks/[notebookId]'>) {
  const { notebookId } = await params;
  return <NotebookDetailView notebookId={notebookId} />;
}
