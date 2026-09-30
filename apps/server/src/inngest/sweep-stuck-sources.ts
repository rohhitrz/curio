import type { Inngest } from 'inngest';
import { ingestion } from '../config/index.js';
import type { IngestionService } from '../services/ingestion.service.js';

/** Runs on a schedule: fails sources stuck in `PROCESSING` and re-sends ones stuck in `PENDING`. */
export function createSweepStuckSourcesFunction(client: Inngest, service: IngestionService) {
  return client.createFunction(
    {
      id: 'sweep-stuck-sources',
      name: 'Sweep stuck sources',
      triggers: [{ cron: ingestion.sweepCron }],
      // The next scheduled run does the same work, so a failed one isn't worth repeating.
      retries: 0,
    },
    ({ step }) => step.run('sweep', () => service.sweep()),
  );
}
