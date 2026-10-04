import { pgEnum } from 'drizzle-orm/pg-core';

/** Shared by `messages` and `lessons`; its own file so `lessons` doesn't import the chat tables. */
export const generationStatus = pgEnum('generation_status', ['COMPLETE', 'ERROR']);
