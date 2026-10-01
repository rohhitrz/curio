/** A step that ran past its deadline. Classified like a network timeout (`name`). */
export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`Step took longer than ${String(ms)}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Runs `fn` with a signal that aborts after `ms`, and rejects with `DeadlineError` at that point
 * even if `fn` ignores the signal, so a hung call can't hold up the answer.
 */
export async function withDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
