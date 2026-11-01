import { closeDb, createDb } from "@yulona/db";
import { startWorker } from "@yulona/queue";
import { createLogger, type LogLevel } from "@yulona/shared";
import { buildJobHandlers } from "./jobs";
import { startMaintenance } from "./maintenance";
import { startBillingJobs } from "./billing";
import { startOpsJobs } from "./ops";

const log = createLogger({ level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info", service: "worker" });

const dbUrl = process.env.DATABASE_URL;
const db = dbUrl ? createDb(dbUrl, { max: Number(process.env.WORKER_DB_POOL_MAX ?? 10), applicationName: "yulona-worker" }) : undefined;
const jobHandlers = db ? buildJobHandlers(db) : {};
const worker = db
  ? startWorker(db, jobHandlers, {
      log,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
      pollIntervalMs: Number(process.env.WORKER_POLL_MS ?? 1000),
      onDead: (job, err) => log.error("job dead-lettered", { job: job.name, jobId: job.id, tenantId: job.tenantId, err: err.message }),
    })
  : undefined;
const stopMaintenance = db ? startMaintenance(db, log) : undefined;
const stopBilling = db ? startBillingJobs(db, log) : undefined; // heartbeat, usage rollup, billing grace expiry
const stopOps = db ? startOpsJobs(db, log) : undefined; // ticket SLA scan, notification emails
// Keep the event loop alive even when idle.
const heartbeat = setInterval(() => log.debug("worker heartbeat"), 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker shutting down", { signal });
  clearInterval(heartbeat);
  stopMaintenance?.();
  stopBilling?.();
  stopOps?.();
  try {
    await worker?.stop(10_000);
    if (db) await closeDb(db, 5);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Announce readiness only after the signal handlers exist, so a SIGTERM sent the moment the line appears still shuts down cleanly.
log.info("worker started", { jobs: Object.keys(jobHandlers), processing: !!db });
if (!db) log.warn("DATABASE_URL not set: worker is idle (no job processing)");
