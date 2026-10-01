import { describe, expect, it } from 'vitest';
import { DeadlineError, withDeadline } from '../../src/pipelines/retrieval/deadline.js';

describe('withDeadline', () => {
  it('returns the result when the step is in time', async () => {
    await expect(withDeadline(1_000, () => Promise.resolve('done'))).resolves.toBe('done');
  });

  it('rejects at the deadline and aborts the signal, even if the step ignores it', async () => {
    let signal: AbortSignal | undefined;
    const started = Date.now();

    const error = await withDeadline(30, (s) => {
      signal = s;
      return new Promise<never>(() => undefined);
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeadlineError);
    expect((error as Error).name).toBe('TimeoutError');
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('passes the step’s own error through', async () => {
    await expect(withDeadline(1_000, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });
});
