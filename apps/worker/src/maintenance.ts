import type { Db } from "@yulona/db";
import type { Logger } from "@yulona/shared";
import { runIntegrationsMaintenance, storageOrDatabase } from "@yulona/integrations";
import { createProvidersFromEnv } from "@yulona/providers";

/** Hard-delete tenants soft-deleted > 30 days ago (SQL function walks every tenant_id table). */
export async function purgeDeletedTenants(db: Db): Promise<number> {
  const [r] = await db<{ platformPurgeDeletedTenants: number }[]>`SELECT platform_purge_deleted_tenants()`;
  return Number(r?.platformPurgeDeletedTenants ?? 0);
}

/** Drop finished jobs older than `days`. */
export async function pruneJobs(db: Db, days = 7): Promise<number> {
  const [r] = await db<{ jobsPrune: number }[]>`SELECT jobs_prune(${days})`;
  return Number(r?.jobsPrune ?? 0);
}

/** Run maintenance now and then hourly. Returns a stop function. */
let storageProvider: ReturnType<typeof createProvidersFromEnv>["storage"] | undefined;
const storageFor = (db: Db) => (storageProvider ??= storageOrDatabase(createProvidersFromEnv().storage, db));

export function startMaintenance(db: Db, log: Logger, everyMs = 3_600_000): () => void {
  const run = async () => {
    try {
      const purged = await purgeDeletedTenants(db);
      const pruned = await pruneJobs(db);
      if (purged || pruned) log.info("maintenance", { purgedTenants: purged, prunedJobs: pruned });
      await runIntegrationsMaintenance(db, log, storageFor(db)); // retention policies + expired GDPR exports
    } catch (e) {
      log.error("maintenance failed", { err: (e as Error).message });
    }
  };
  void run();
  const t = setInterval(run, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
