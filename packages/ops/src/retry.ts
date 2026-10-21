export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Return false to stop retrying (e.g. HTTP 4xx). */
  retryable?: (e: unknown) => boolean;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
  }
}

/** Run `fn(signal)` with a per-attempt timeout and exponential backoff (baseMs, 2x, ...). Throws the last error. */
export async function withRetry<T>(fn: (signal: AbortSignal) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? 3;
  const base = o.baseMs ?? 500;
  const timeout = o.timeoutMs ?? 8000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      return await Promise.race([
        fn(ac.signal),
        new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new TimeoutError(timeout)))),
      ]);
    } catch (e) {
      last = e;
      if (o.retryable && !o.retryable(e)) break;
      if (i < attempts - 1) await sleep(base * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
