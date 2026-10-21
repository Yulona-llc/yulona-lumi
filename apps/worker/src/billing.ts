import type { Db } from "@yulona/db";
import type { Logger } from "@yulona/shared";

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Recompute per-tenant daily usage for yesterday + today (idempotent upserts). */
export async function runUsageRollup(db: Db, now = new Date()): Promise<number> {
  const from = day(new Date(now.getTime() - 86_400_000));
  const [r] = await db<{ usageRollup: number }[]>`SELECT usage_rollup(${from}::date, ${day(now)}::date)`;
  return Number(r?.usageRollup ?? 0);
}

/** Open the new month's credit rows (carrying top-up balances) for tenants that had one last period. */
export async function rolloverCredits(db: Db): Promise<number> {
  const [r] = await db<{ creditsRollover: number }[]>`SELECT credits_rollover()`;
  return Number(r?.creditsRollover ?? 0);
}

/** Downgrade tenants whose payment grace window has expired. */
export async function expireBillingGrace(db: Db): Promise<number> {
  const [r] = await db<{ billingExpireGrace: number }[]>`SELECT billing_expire_grace()`;
  return Number(r?.billingExpireGrace ?? 0);
}

export async function beat(db: Db, name = "worker"): Promise<void> {
  await db`SELECT worker_heartbeat(${name})`;
}

/** Heartbeat every `beatMs`; usage rollup + grace expiry now and every `everyMs`. Returns a stop function. */
export function startBillingJobs(db: Db, log: Logger, opts: { beatMs?: number; everyMs?: number } = {}): () => void {
  const safe = (label: string, fn: () => Promise<unknown>) => () => { fn().catch((e) => log.error(`${label} failed`, { err: (e as Error).message })); };
  const hb = safe("worker heartbeat", () => beat(db));
  const hourly = safe("billing maintenance", async () => {
    const [rolled, expired] = [await runUsageRollup(db), await expireBillingGrace(db)];
    if (process.env.DEPLOYMENT_MODE !== "selfhosted") {
      const opened = await rolloverCredits(db);
      if (opened) log.info("credit periods opened", { tenants: opened });
    }
    if (expired) log.info("billing grace expired", { downgraded: expired });
    log.debug("usage rollup", { rows: rolled });
  });
  hb();
  hourly();
  const t1 = setInterval(hb, opts.beatMs ?? 30_000);
  const t2 = setInterval(hourly, opts.everyMs ?? 3_600_000);
  t1.unref?.();
  t2.unref?.();
  return () => { clearInterval(t1); clearInterval(t2); };
}
