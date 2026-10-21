import { withTenant, assertUuid, type Db, type Tx } from "@yulona/db";
import type { Logger } from "@yulona/shared";

export interface EnqueueInput {
  name: string;
  tenantId: string;
  payload?: unknown;
  runAt?: Date;
  maxAttempts?: number;
}

function isTx(x: Db | Tx): x is Tx {
  return typeof (x as Tx).savepoint === "function";
}

/**
 * Enqueue a job. Pass a `Tx` from `withTenant` to make the job atomic with your other writes
 * (preferred), or a `Db` (a short tenant transaction is opened). The tx's tenant GUC must match
 * `tenantId` (RLS WITH CHECK rejects otherwise). Returns the job id.
 */
export async function enqueue(db: Db | Tx, input: EnqueueInput): Promise<string> {
  assertUuid(input.tenantId, "tenantId");
  const run = async (tx: Db | Tx) => {
    const [row] = await tx<{ id: string }[]>`
      -- no runAt => the database clock (an app host a few ms ahead of the DB would otherwise make a fresh job "not due yet")
      INSERT INTO jobs (tenant_id, name, payload, run_at, max_attempts)
      VALUES (${input.tenantId}, ${input.name}, ${tx.json((input.payload ?? {}) as never)},
              COALESCE(${input.runAt ? input.runAt.toISOString() : null}::timestamptz, now()), ${input.maxAttempts ?? 5})
      RETURNING id`;
    return row!.id;
  };
  return isTx(db) ? run(db) : withTenant(db, input.tenantId, run);
}

export interface Job {
  id: string;
  tenantId: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}
export interface JobContext {
  job: Job;
  db: Db;
  log: Logger | undefined;
  /** Run `fn` in a transaction scoped to the job's tenant (RLS applies). */
  withTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
export type JobHandler = (payload: any, ctx: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

/** Throw from a handler to dead-letter immediately (no retries). */
export class FatalJobError extends Error {}

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  concurrency?: number;
  lockTimeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  log?: Logger;
  onDead?: (job: Job, err: Error) => void;
}
export interface Worker {
  /** Claim and run one batch now; resolves when that batch finished. Returns number of jobs run. */
  tick(): Promise<number>;
  /** Stop polling and wait for in-flight jobs (up to timeoutMs). */
  stop(timeoutMs?: number): Promise<void>;
}

export function backoffMs(attempt: number, base = 1000, max = 3_600_000, rand = Math.random): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + rand() * 0.4)); // +-20% jitter
}

export function startWorker(db: Db, handlers: JobHandlers, opts: WorkerOptions = {}): Worker {
  const workerId = opts.workerId ?? `w-${crypto.randomUUID().slice(0, 8)}`;
  const concurrency = opts.concurrency ?? 5;
  const lockSecs = Math.ceil((opts.lockTimeoutMs ?? 300_000) / 1000);
  const names = Object.keys(handlers);
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<number> | undefined;

  async function runJob(job: Job) {
    const ctx: JobContext = { job, db, log: opts.log, withTenant: (fn) => withTenant(db, job.tenantId, fn) };
    try {
      const h = handlers[job.name];
      if (!h) throw new FatalJobError(`no handler for ${job.name}`);
      await h(job.payload, ctx);
      await db`SELECT jobs_complete(${job.id}, ${workerId})`;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const fatal = e instanceof FatalJobError;
      const delay = backoffMs(job.attempts, opts.baseBackoffMs, opts.maxBackoffMs) / 1000;
      try {
        const [r] = await db<{ jobsFail: string }[]>`SELECT jobs_fail(${job.id}, ${workerId}, ${err.message}, ${delay}, ${fatal})`;
        opts.log?.warn("job failed", { job: job.name, jobId: job.id, attempt: job.attempts, status: r?.jobsFail, err: err.message });
        if (r?.jobsFail === "dead") opts.onDead?.(job, err);
      } catch (e2) {
        opts.log?.error("could not record job failure", { jobId: job.id, err: (e2 as Error).message });
      }
    }
  }

  async function tick(): Promise<number> {
    if (stopped || names.length === 0) return 0;
    const free = concurrency - inflight.size;
    if (free <= 0) return 0;
    const rows = await db<Job[]>`SELECT * FROM jobs_claim(${workerId}, ${names}, ${free}, ${lockSecs})`;
    const batch = rows.map((r) => {
      const p: Promise<void> = runJob(r).finally(() => inflight.delete(p));
      inflight.add(p);
      return p;
    });
    await Promise.all(batch);
    return rows.length;
  }

  function schedule(delay: number) {
    if (stopped) return;
    timer = setTimeout(async () => {
      polling = tick().catch((e) => {
        opts.log?.error("worker poll failed", { err: (e as Error).message });
        return 0;
      });
      const n = await polling;
      schedule(n > 0 ? 0 : opts.pollIntervalMs ?? 1000);
    }, delay);
  }
  schedule(0);

  return {
    tick,
    async stop(timeoutMs = 10_000) {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.race([
        Promise.allSettled([polling, ...inflight]),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    },
  };
}
