import { pgEnum } from 'drizzle-orm/pg-core';

/** Shared by `memories` and `learning_paths`; its own file so neither imports the other's table. */
export const level = pgEnum('level', ['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);
