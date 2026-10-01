/** Every background-job event and its payload. Payloads carry IDs only; jobs read the rest from the DB. */
export interface JobEvents {
  'source/created': { sourceId: string; userId: string };
  /** Process the source again: asked for by the user, or re-sent by the sweeper. */
  'source/reprocess': { sourceId: string; userId: string };
  /** The rows are already gone, so the files to delete travel with the event. */
  'notebook/deleted': { notebookId: string; userId: string; storageKeys: string[] };
  /** Fold older messages into the conversation's rolling summary. */
  'conversation/summarize': { conversationId: string; userId: string };
}

export type JobEventName = keyof JobEvents;

export interface JobsProvider {
  /** Queues an event. Rejects when the job service can't be reached. */
  send<Name extends JobEventName>(name: Name, data: JobEvents[Name]): Promise<void>;
}
