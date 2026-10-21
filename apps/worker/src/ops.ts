import type { Db } from "@yulona/db";
import { startOpsScheduler } from "@yulona/ops";
import { createProvidersFromEnv } from "@yulona/providers";
import type { Logger } from "@yulona/shared";

/** Ticket SLA breach scan (60 s) + notification email dispatch (15 s). Returns a stop function. */
export function startOpsJobs(db: Db, log: Logger): () => void {
  return startOpsScheduler({ db, log, email: createProvidersFromEnv().email, appUrl: process.env.APP_URL });
}
