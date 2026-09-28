import { z } from 'zod';

/** API contract for cursor pagination (docs/04-api-design.md §1). */
export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

/** Query: `?limit=20&cursor=<opaque>`. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** List response: `{ items, nextCursor }`. */
export const paginatedResponseSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
