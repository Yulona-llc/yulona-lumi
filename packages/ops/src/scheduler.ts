import type { Db } from "@yulona/db";
import type { EmailProvider } from "@yulona/providers";
import type { Logger } from "@yulona/shared";

interface PendingEmail {
  id: string;
  tenantId: string;
  toEmail: string;
  toName: string;
  type: string;
  title: string;
  body: string | null;
  attempts: number;
}

/** Send queued notification emails (claimed with SKIP LOCKED; a failed send is retried up to 5 attempts). */
export async function dispatchNotificationEmails(
  db: Db, email: EmailProvider, opts: { appUrl?: string; limit?: number; log?: Logger } = {},
): Promise<{ sent: number; failed: number }> {
  const rows = await db<PendingEmail[]>`SELECT * FROM ops_notifications_claim_email(${opts.limit ?? 25})`;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await email.send({
        to: r.toEmail,
        subject: r.title,
        text: `Hi ${r.toName},\n\n${r.title}${r.body ? `\n\n${r.body}` : ""}\n\n${opts.appUrl ? `Open Lumi: ${opts.appUrl}\n` : ""}`,
      });
      await db`SELECT ops_notification_email_done(${r.id}::uuid, true, NULL)`;
      sent++;
    } catch (e) {
      failed++;
      opts.log?.warn("notification email failed", { id: r.id, attempt: r.attempts, err: (e as Error).message });
      await db`SELECT ops_notification_email_done(${r.id}::uuid, false, ${(e as Error).message})`;
    }
  }
  return { sent, failed };
}

export async function runSlaScan(db: Db): Promise<number> {
  const [r] = await db<{ opsSlaScan: number }[]>`SELECT ops_sla_scan()`;
  return Number(r?.opsSlaScan ?? 0);
}

/** Interval tasks for the worker process: SLA breach scan + notification email dispatch. Returns a stop function. */
export function startOpsScheduler(o: {
  db: Db; log: Logger; email: EmailProvider; appUrl?: string; slaEveryMs?: number; emailEveryMs?: number;
}): () => void {
  let stopped = false;
  const guard = (name: string, fn: () => Promise<void>) => {
    let running = false;
    return async () => {
      if (stopped || running) return;
      running = true;
      try { await fn(); } catch (e) { o.log.error(`ops ${name} failed`, { err: (e as Error).message }); } finally { running = false; }
    };
  };
  const sla = guard("sla scan", async () => {
    const n = await runSlaScan(o.db);
    if (n) o.log.info("ticket SLA breaches recorded", { count: n });
  });
  const mail = guard("email dispatch", async () => {
    const r = await dispatchNotificationEmails(o.db, o.email, { appUrl: o.appUrl, log: o.log });
    if (r.sent || r.failed) o.log.info("notification emails", r);
  });
  const timers = [setInterval(sla, o.slaEveryMs ?? 60_000), setInterval(mail, o.emailEveryMs ?? 15_000)];
  for (const t of timers) t.unref?.();
  void sla();
  void mail();
  return () => {
    stopped = true;
    timers.forEach(clearInterval);
  };
}
