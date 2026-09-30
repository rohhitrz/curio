import type { Inngest } from 'inngest';
import { z } from 'zod';
import { ingestion } from '../config/index.js';
import type { NotebooksService } from '../services/notebooks.service.js';

const eventData = z.object({
  notebookId: z.uuid(),
  userId: z.uuid(),
  storageKeys: z.array(z.string().min(1)),
});

/** Deletes a deleted notebook's uploaded files from R2. The rows are gone; the event has the keys. */
export function createCleanupNotebookFilesFunction(client: Inngest, service: NotebooksService) {
  return client.createFunction(
    {
      id: 'cleanup-notebook-files',
      name: 'Clean up notebook files',
      triggers: [{ event: 'notebook/deleted' }],
      retries: ingestion.retries,
    },
    async ({ event, step }) => {
      const { userId, storageKeys } = eventData.parse(event.data);
      return step.run('delete-files', () => service.deleteFiles(userId, storageKeys));
    },
  );
}
