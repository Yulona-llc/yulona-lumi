import type { Db } from "@yulona/db";
import type { StorageProvider } from "@yulona/providers";
import type { Logger } from "@yulona/shared";

export interface RetentionResult {
  messages: number; auditLogs: number; toolExecutions: number; webhookDeliveries: number; exportFiles: number;
}

/**
 * Apply every tenant's retention policy (SQL: retention_run_all, bounded batches, repeated while a
 * batch comes back full) and delete expired GDPR export files from object storage.
 */
export async function runRetention(db: Db, opts: { storage?: StorageProvider; batch?: number; maxRounds?: number } = {}): Promise<RetentionResult> {
  const batch = opts.batch ?? 5000;
  const total: RetentionResult = { messages: 0, auditLogs: 0, toolExecutions: 0, webhookDeliveries: 0, exportFiles: 0 };
  for (let round = 0; round < (opts.maxRounds ?? 20); round++) {
    const [r] = await db<{ retentionRunAll: Record<string, number> }[]>`SELECT retention_run_all(${batch})`;
    const x = r!.retentionRunAll;
    total.messages += Number(x.messages); total.auditLogs += Number(x.auditLogs);
    total.toolExecutions += Number(x.toolExecutions); total.webhookDeliveries += Number(x.webhookDeliveries);
    if (![x.messages, x.auditLogs, x.toolExecutions, x.webhookDeliveries].some((n) => Number(n) >= batch)) break;
  }
  if (opts.storage) {
    const expired = await db<{ id: string; tenantId: string; storageKey: string }[]>`SELECT * FROM gdpr_expired_exports(100)`;
    for (const e of expired) {
      try {
        await opts.storage.delete(e.storageKey);
        await db`SELECT gdpr_expired_mark(${e.id})`;
        total.exportFiles++;
      } catch {
        // keep the key; retried on the next sweep
      }
    }
  }
  return total;
}

/** Hourly hook for the worker's maintenance loop; never throws. */
export async function runIntegrationsMaintenance(db: Db, log: Logger, storage?: StorageProvider): Promise<void> {
  try {
    const r = await runRetention(db, { storage });
    if (Object.values(r).some((n) => n > 0)) log.info("retention sweep", { ...r });
  } catch (e) {
    log.error("retention sweep failed", { err: (e as Error).message });
  }
}
