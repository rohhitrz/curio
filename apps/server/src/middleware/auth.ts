import type { Request, RequestHandler } from 'express';
import { UnauthorizedError } from '../errors/app-error.js';
import type { AuthProvider } from '../lib/auth/index.js';
import type { UsersService } from '../services/users.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own extension point
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/** Requires a valid token, then attaches our internal `userId` (creating the user on first request). */
export function requireAuth(auth: AuthProvider, usersService: UsersService): RequestHandler[] {
  const attachUser: RequestHandler = async (req, _res, next) => {
    const clerkUserId = auth.getClerkUserId(req);
    if (!clerkUserId) throw new UnauthorizedError();
    req.userId = await usersService.getOrCreateUserId(clerkUserId);
    next();
  };
  return [auth.middleware, attachUser];
}

/** The authenticated user's ID. Only valid behind `requireAuth`. */
export function getUserId(req: Request): string {
  if (!req.userId) throw new UnauthorizedError();
  return req.userId;
}
