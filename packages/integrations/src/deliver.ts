import { assertSafeUrl, SsrfError, type Resolver } from "@yulona/ai-runtime";
import { assertUuid, type Tx } from "@yulona/db";
import { enqueue, type JobContext, type JobHandler } from "@yulona/queue";
import { DELIVERY_HEADER, EVENT_HEADER, openSecret, SIGNATURE_HEADER, signWebhook, TIMESTAMP_HEADER } from "./signing";

/** Seconds to wait after failed attempt N (index N-1). 8 attempts total, last retry after 24 h. */
export const RETRY_SCHEDULE_SEC = [30, 120, 600, 3600, 10_800, 43_200, 86_400] as const;
/** Disable a webhook after this many consecutive deliveries exhausted all their attempts. */
export const AUTO_DISABLE_AFTER = 10;
export const DELIVER_JOB = "webhook.deliver";

export interface DeliverOptions {
  /** base64 32-byte key used to open webhook secrets (defaults to process.env.ENCRYPTION_KEY) */
  encryptionKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  timeoutMs?: number;
  retryScheduleSec?: readonly number[];
  now?: () => Date;
}

interface DeliveryRow {
  id: string; webhookId: string; eventType: string; payload: unknown; status: string; attempts: number; maxAttempts: number;
  url: string | null; secretEncrypted: string | null; enabled: boolean | null;
}

/** Queue a pending delivery row as a job (same tx as the insert). */
export function enqueueDelivery(tx: Tx, tenantId: string, deliveryId: string, runAt?: Date): Promise<string> {
  return enqueue(tx, { name: DELIVER_JOB, tenantId, payload: { deliveryId }, runAt, maxAttempts: 3 });
}

async function readSnippet(res: Response, max = 2000): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return "";
    let out = "";
    const dec = new TextDecoder();
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return out.slice(0, max);
  } catch {
    return "";
  }
}

/**
 * One delivery attempt. HTTP happens outside any DB transaction. Retries are scheduled by enqueueing a
 * new job with `runAt` (the generic queue backoff is too short for webhooks). At-least-once: receivers
 * should de-duplicate on the envelope `id`.
 */
export function createWebhookDeliverHandler(opts: DeliverOptions = {}): JobHandler {
  const schedule = opts.retryScheduleSec ?? RETRY_SCHEDULE_SEC;
  const now = opts.now ?? (() => new Date());
  const f = opts.fetchImpl ?? fetch;
  return async (payload: { deliveryId?: string }, ctx: JobContext) => {
    const deliveryId = payload?.deliveryId ?? "";
    assertUuid(deliveryId, "deliveryId");
    const row = await ctx.withTenant(async (tx) => {
      const [r] = await tx<DeliveryRow[]>`
        SELECT d.id, d.webhook_id, d.event_type, d.payload, d.status, d.attempts, d.max_attempts,
               w.url, w.secret_encrypted, w.enabled
        FROM webhook_deliveries d LEFT JOIN webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
        WHERE d.tenant_id = ${ctx.job.tenantId} AND d.id = ${deliveryId} FOR UPDATE OF d`;
      if (!r || !["pending", "retrying"].includes(r.status)) return null;
      if (!r.url || !r.secretEncrypted || r.enabled === false) {
        await tx`UPDATE webhook_deliveries SET status = 'cancelled', completed_at = now(), next_attempt_at = NULL,
                   last_error = 'webhook disabled or deleted' WHERE tenant_id = ${ctx.job.tenantId} AND id = ${deliveryId}`;
        return null;
      }
      return r;
    });
    if (!row) return;

    const attempt = row.attempts + 1;
    const body = JSON.stringify(row.payload);
    const ts = Math.floor(now().getTime() / 1000);
    let statusCode: number | null = null;
    let error: string | null = null;
    let snippet = "";
    let permanent = false;
    let gone = false;
    const started = performance.now();
    try {
      const secret = openSecret((opts.encryptionKey ?? (() => process.env.ENCRYPTION_KEY))(), row.secretEncrypted!, row.webhookId);
      const u = await assertSafeUrl(row.url!, opts.resolver);
      const res = await f(u, {
        method: "POST",
        redirect: "manual", // a redirect could point at an internal address: never follow
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": "Yulona-Webhooks/1.0",
          [EVENT_HEADER]: row.eventType,
          [DELIVERY_HEADER]: row.id,
          [TIMESTAMP_HEADER]: String(ts),
          [SIGNATURE_HEADER]: signWebhook(secret, ts, body),
        },
      });
      statusCode = res.status;
      snippet = await readSnippet(res);
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      if (res.status === 410) gone = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = msg.slice(0, 500);
      // blocked destinations never become valid by waiting (an unresolvable host might)
      if (e instanceof SsrfError && !/did not resolve/.test(msg)) permanent = true;
    }
    const durationMs = Math.round(performance.now() - started);
    const ok = error === null;
    const exhausted = attempt >= row.maxAttempts;
    const final = ok || permanent || gone || exhausted;
    const nextAt = final ? null : new Date(now().getTime() + (schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 86_400) * 1000);

    await ctx.withTenant(async (tx) => {
      await tx`INSERT INTO webhook_delivery_attempts (tenant_id, delivery_id, attempt, status_code, error, duration_ms, response_snippet)
               VALUES (${ctx.job.tenantId}, ${deliveryId}, ${attempt}, ${statusCode}, ${error}, ${durationMs}, ${snippet || null})`;
      await tx`UPDATE webhook_deliveries SET attempts = ${attempt}, response_status = ${statusCode}, last_error = ${error},
                 last_duration_ms = ${durationMs},
                 status = ${ok ? "succeeded" : final ? "failed" : "retrying"},
                 next_attempt_at = ${nextAt ? nextAt.toISOString() : null}::timestamptz,
                 completed_at = ${final ? now().toISOString() : null}::timestamptz
               WHERE tenant_id = ${ctx.job.tenantId} AND id = ${deliveryId}`;
      if (ok) {
        await tx`UPDATE webhooks SET consecutive_failures = 0, last_success_at = now()
                 WHERE tenant_id = ${ctx.job.tenantId} AND id = ${row.webhookId}`;
      } else {
        await tx`UPDATE webhooks SET last_failure_at = now(),
                   consecutive_failures = consecutive_failures + ${final ? 1 : 0}
                 WHERE tenant_id = ${ctx.job.tenantId} AND id = ${row.webhookId}`;
        if (gone) {
          await tx`UPDATE webhooks SET enabled = false, disabled_reason = 'Endpoint returned 410 Gone', updated_at = now()
                   WHERE tenant_id = ${ctx.job.tenantId} AND id = ${row.webhookId}`;
        } else if (final) {
          await tx`UPDATE webhooks SET enabled = false, disabled_reason = ${`Disabled after ${AUTO_DISABLE_AFTER} consecutive failed deliveries`}, updated_at = now()
                   WHERE tenant_id = ${ctx.job.tenantId} AND id = ${row.webhookId} AND enabled AND consecutive_failures >= ${AUTO_DISABLE_AFTER}`;
        }
      }
      if (nextAt) await enqueueDelivery(tx, ctx.job.tenantId, deliveryId, nextAt);
    });
  };
}
