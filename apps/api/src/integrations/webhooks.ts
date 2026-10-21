import { Hono } from "hono";
import { z } from "zod";
import { TenantRepository, withTenant, type Tx } from "@yulona/db";
import { enqueueDelivery, generateWebhookSecret, sealSecret, WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT, webhookUrlProblem } from "@yulona/integrations";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { audit, parseId, parseQuery } from "../platform/util";
import type { AppEnv } from "../context";
import { cursorOf } from "../conversations/common";
import { encodeCursor } from "../conversations/dto";
import { iso, type IntegrationsDeps } from "./common";

export const MAX_WEBHOOKS_PER_TENANT = 20;
const eventSchema = z.enum([...WEBHOOK_EVENTS, "*"]);
const events = z.array(eventSchema).min(1).max(20).transform((a) => [...new Set(a)]);

export const createWebhookSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2000),
  events,
  enabled: z.boolean().default(true),
});
export const patchWebhookSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    url: z.string().trim().max(2000).optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes supplied" });
const deliveriesQuery = z.strictObject({
  status: z.enum(["pending", "retrying", "succeeded", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

interface HookRow {
  id: string; name: string; url: string; events: string[]; enabled: boolean; disabledReason: string | null;
  consecutiveFailures: number; lastSuccessAt: Date | null; lastFailureAt: Date | null; createdAt: Date; updatedAt: Date;
}
const hookCols = (tx: Tx) => tx`id, name, url, events, enabled, disabled_reason, consecutive_failures, last_success_at, last_failure_at, created_at, updated_at`;
const hookDto = (h: HookRow) => ({
  id: h.id, name: h.name, url: h.url, events: h.events, enabled: h.enabled, disabledReason: h.disabledReason,
  consecutiveFailures: h.consecutiveFailures, lastSuccessAt: iso(h.lastSuccessAt), lastFailureAt: iso(h.lastFailureAt),
  createdAt: iso(h.createdAt)!, updatedAt: iso(h.updatedAt)!,
});

interface DeliveryRow {
  id: string; webhookId: string; eventId: string; eventType: string; status: string; attempts: number; maxAttempts: number;
  nextAttemptAt: Date | null; responseStatus: number | null; lastError: string | null; lastDurationMs: number | null;
  redeliveryOf: string | null; createdAt: Date; completedAt: Date | null; cursorTs?: string; payload?: unknown;
}
const deliveryDto = (d: DeliveryRow) => ({
  id: d.id, webhookId: d.webhookId, eventId: d.eventId, eventType: d.eventType, status: d.status, attempts: d.attempts,
  maxAttempts: d.maxAttempts, nextAttemptAt: iso(d.nextAttemptAt), responseStatus: d.responseStatus, lastError: d.lastError,
  lastDurationMs: d.lastDurationMs, redeliveryOf: d.redeliveryOf, createdAt: iso(d.createdAt)!, completedAt: iso(d.completedAt),
});
const deliveryCols = (tx: Tx) => tx`d.id, d.webhook_id, d.event_id, d.event_type, d.status, d.attempts, d.max_attempts, d.next_attempt_at,
  d.response_status, d.last_error, d.last_duration_ms, d.redelivery_of, d.created_at, d.completed_at,
  to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

class WebhooksRepository extends TenantRepository {
  list() {
    return this.tx<HookRow[]>`SELECT ${hookCols(this.tx)} FROM webhooks WHERE tenant_id = ${this.tenantId} ORDER BY created_at, id`;
  }
  async get(id: string, lock = false) {
    const tx = this.tx;
    const [r] = await tx<HookRow[]>`SELECT ${hookCols(tx)} FROM webhooks WHERE tenant_id = ${this.tenantId} AND id = ${id} ${lock ? tx`FOR UPDATE` : tx``}`;
    return r;
  }
  async count() {
    const [r] = await this.tx<{ n: number }[]>`SELECT count(*)::int AS n FROM webhooks WHERE tenant_id = ${this.tenantId}`;
    return r!.n;
  }
}

export function webhookRoutes({ cfg, db }: IntegrationsDeps) {
  const r = new Hono<AppEnv>();
  // Per-route guard on purpose: `/api/v1/webhooks/*` also hosts public receivers owned by other areas
  // (billing, channels, transactions), so a path-wide `use` would put them behind JWT auth.
  const g = [requireAuth(cfg), requireMinRole("admin")] as const;

  const needKey = () => {
    if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "Webhooks require ENCRYPTION_KEY to be configured");
  };
  const checkUrl = (url: string) => {
    const p = webhookUrlProblem(url, { allowHttp: !cfg.isProd });
    if (p) throw Errors.validation([{ path: "url", message: p }]);
  };

  r.get("/webhooks/events", ...g, (c) => c.json({ events: [...WEBHOOK_EVENTS, "*"] }));

  r.get("/webhooks", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new WebhooksRepository(tx, tenantId).list());
    return c.json({ items: rows.map(hookDto) });
  });

  r.post("/webhooks", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const body = await parseBody(c, createWebhookSchema);
    needKey();
    checkUrl(body.url);
    const secret = generateWebhookSecret();
    const id = crypto.randomUUID();
    const sealed = sealSecret(cfg.encryptionKey, secret, id);
    const row = await withTenant(db, tenantId, async (tx) => {
      if ((await new WebhooksRepository(tx, tenantId).count()) >= MAX_WEBHOOKS_PER_TENANT) {
        throw Errors.conflict(`Webhook limit reached (${MAX_WEBHOOKS_PER_TENANT})`);
      }
      await tx`INSERT INTO webhooks (id, tenant_id, name, url, secret_encrypted, events, enabled, created_by)
               VALUES (${id}, ${tenantId}, ${body.name}, ${body.url}, ${sealed}, ${body.events}, ${body.enabled}, ${c.get("auth").userId})`;
      await audit(tx, c, "webhook.created", "webhook", id, { name: body.name, url: body.url, events: body.events });
      return (await new WebhooksRepository(tx, tenantId).get(id))!;
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ...hookDto(row), secret }, 201); // the only time the secret is returned (besides rotation)
  });

  r.get("/webhooks/:id", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const row = await withTenant(db, tenantId, (tx) => new WebhooksRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Webhook not found");
    return c.json(hookDto(row));
  });

  r.patch("/webhooks/:id", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, patchWebhookSchema);
    if (body.url !== undefined) checkUrl(body.url);
    const row = await withTenant(db, tenantId, async (tx) => {
      const repo = new WebhooksRepository(tx, tenantId);
      if (!(await repo.get(id, true))) return null;
      await tx`UPDATE webhooks SET
        name = ${body.name ?? tx`name`}, url = ${body.url ?? tx`url`}, events = ${body.events ?? tx`events`},
        enabled = ${body.enabled ?? tx`enabled`},
        -- re-enabling clears the failure state so the auto-disable counter starts over
        consecutive_failures = ${body.enabled === true ? 0 : tx`consecutive_failures`},
        disabled_reason = ${body.enabled === true ? null : body.enabled === false ? "Disabled manually" : tx`disabled_reason`},
        updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id}`;
      await audit(tx, c, "webhook.updated", "webhook", id, { fields: Object.keys(body) });
      return repo.get(id);
    });
    if (!row) throw Errors.notFound("Webhook not found");
    return c.json(hookDto(row));
  });

  r.delete("/webhooks/:id", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const done = await tx`DELETE FROM webhooks WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (done.length) await audit(tx, c, "webhook.deleted", "webhook", id);
      return done.length > 0;
    });
    if (!ok) throw Errors.notFound("Webhook not found");
    return c.json({ ok: true as const });
  });

  r.post("/webhooks/:id/rotate-secret", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    needKey();
    const secret = generateWebhookSecret();
    const sealed = sealSecret(cfg.encryptionKey, secret, id);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const done = await tx`UPDATE webhooks SET secret_encrypted = ${sealed}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (done.length) await audit(tx, c, "webhook.secret_rotated", "webhook", id);
      return done.length > 0;
    });
    if (!ok) throw Errors.notFound("Webhook not found");
    c.header("Cache-Control", "no-store");
    return c.json({ id, secret });
  });

  /** Sends a signed `webhook.test` event (works even when the webhook is not subscribed to it). */
  r.post("/webhooks/:id/test", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const deliveryId = await withTenant(db, tenantId, async (tx) => {
      const hook = await new WebhooksRepository(tx, tenantId).get(id);
      if (!hook) return null;
      const eventId = crypto.randomUUID();
      const payload = { id: eventId, type: WEBHOOK_TEST_EVENT, createdAt: new Date().toISOString(), tenantId, data: { message: "Test event from Yulona", webhookId: id } };
      const [d] = await tx<{ id: string }[]>`
        INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, next_attempt_at)
        VALUES (${tenantId}, ${id}, ${eventId}, ${WEBHOOK_TEST_EVENT}, ${tx.json(payload as never)}, now()) RETURNING id`;
      await enqueueDelivery(tx, tenantId, d!.id);
      await audit(tx, c, "webhook.tested", "webhook", id, { deliveryId: d!.id });
      return d!.id;
    });
    if (!deliveryId) throw Errors.notFound("Webhook not found");
    return c.json({ deliveryId }, 202);
  });

  r.get("/webhooks/:id/deliveries", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const q = parseQuery(c, deliveriesQuery);
    const cursor = cursorOf(q.cursor);
    const out = await withTenant(db, tenantId, async (tx) => {
      if (!(await new WebhooksRepository(tx, tenantId).get(id))) return null;
      return tx<DeliveryRow[]>`
        SELECT ${deliveryCols(tx)} FROM webhook_deliveries d
        WHERE d.tenant_id = ${tenantId} AND d.webhook_id = ${id}
          ${q.status ? tx`AND d.status = ${q.status}` : tx``}
          ${cursor ? tx`AND (d.created_at, d.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : tx``}
        ORDER BY d.created_at DESC, d.id DESC LIMIT ${q.limit + 1}`;
    });
    if (!out) throw Errors.notFound("Webhook not found");
    const page = out.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(deliveryDto), nextCursor: out.length > q.limit && last ? encodeCursor(last.cursorTs!, last.id) : null });
  });

  r.get("/webhook-deliveries/:id", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const out = await withTenant(db, tenantId, async (tx) => {
      const [d] = await tx<DeliveryRow[]>`SELECT ${deliveryCols(tx)}, d.payload FROM webhook_deliveries d WHERE d.tenant_id = ${tenantId} AND d.id = ${id}`;
      if (!d) return null;
      const attempts = await tx<{ attempt: number; statusCode: number | null; error: string | null; durationMs: number | null; responseSnippet: string | null; createdAt: Date }[]>`
        SELECT attempt, status_code, error, duration_ms, response_snippet, created_at FROM webhook_delivery_attempts
        WHERE tenant_id = ${tenantId} AND delivery_id = ${id} ORDER BY attempt`;
      return { d, attempts };
    });
    if (!out) throw Errors.notFound("Delivery not found");
    return c.json({
      ...deliveryDto(out.d), payload: out.d.payload,
      attemptLog: out.attempts.map((a) => ({ attempt: a.attempt, statusCode: a.statusCode, error: a.error, durationMs: a.durationMs, responseSnippet: a.responseSnippet, at: iso(a.createdAt)! })),
    });
  });

  /** Clone a delivery (same event id + payload) as a fresh one and queue it immediately. */
  r.post("/webhook-deliveries/:id/redeliver", ...g, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const newId = await withTenant(db, tenantId, async (tx) => {
      const [src] = await tx<{ webhookId: string; eventId: string; eventType: string; payload: unknown; enabled: boolean | null }[]>`
        SELECT d.webhook_id, d.event_id, d.event_type, d.payload, w.enabled FROM webhook_deliveries d
        LEFT JOIN webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
        WHERE d.tenant_id = ${tenantId} AND d.id = ${id}`;
      if (!src) return null;
      if (!src.enabled) throw Errors.conflict("Webhook is disabled; enable it before redelivering");
      const [d] = await tx<{ id: string }[]>`
        INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, redelivery_of, next_attempt_at)
        VALUES (${tenantId}, ${src.webhookId}, ${src.eventId}, ${src.eventType}, ${tx.json(src.payload as never)}, ${id}, now()) RETURNING id`;
      await enqueueDelivery(tx, tenantId, d!.id);
      await audit(tx, c, "webhook.redelivered", "webhook_delivery", id, { newDeliveryId: d!.id });
      return d!.id;
    });
    if (!newId) throw Errors.notFound("Delivery not found");
    return c.json({ deliveryId: newId }, 202);
  });

  return r;
}
