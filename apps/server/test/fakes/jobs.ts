import type { JobEventName, JobEvents, JobsProvider } from '../../src/lib/jobs/index.js';

export type SentJobEvent = {
  [Name in JobEventName]: { name: Name; data: JobEvents[Name] };
}[JobEventName];

/** Records sent events instead of queueing them. */
export function createFakeJobs() {
  const sent: SentJobEvent[] = [];
  let failNext: Error | null = null;

  const provider: JobsProvider = {
    async send(name, data) {
      if (failNext) {
        const error = failNext;
        failNext = null;
        return Promise.reject(error);
      }
      sent.push({ name, data } as SentJobEvent);
    },
  };

  return {
    provider,
    sent,
    /** The next send rejects with this error (e.g. to simulate Inngest being down). */
    failNextSend(error: Error) {
      failNext = error;
    },
  };
}

export type FakeJobs = ReturnType<typeof createFakeJobs>;
