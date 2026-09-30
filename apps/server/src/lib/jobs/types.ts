/** Every background-job event and its payload. Payloads carry IDs only; jobs read the rest from the DB. */
export interface JobEvents {
  'source/created': { sourceId: string; userId: string };
}

export type JobEventName = keyof JobEvents;

export interface JobsProvider {
  /** Queues an event. Rejects when the job service can't be reached. */
  send<Name extends JobEventName>(name: Name, data: JobEvents[Name]): Promise<void>;
}
