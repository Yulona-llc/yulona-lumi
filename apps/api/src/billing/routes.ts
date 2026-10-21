// Tenant-facing billing: state, checkout/portal/cancel, usage history, audit export, and the provider webhook.
import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Db } from "@yulona/db";
import { ProviderError, type Providers } from "@yulona/providers";
import type { Logger } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { requireMinRole, requireRole } from "../platform/authz";
import { LIMIT_METRICS, checkLimit } from "../platform/limits";
import { audit, parseQuery } from "../platform/util";
import { applyCreditTopup, mountCreditBilling } from "./credits";
import { toCsv } from "./csv";

export const GRACE_DAYS = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.BILLING_GRACE_DAYS ?? 7);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : 7;
};

interface BillingRow {
  customerId: string; subscriptionId: string | null; status: string; planKey: string | null;
  currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; graceUntil: Date | null;
}

export type BillingState = "ok" | "warning" | "grace" | "restricted" | "canceled";
export function billingState(b: Pick<BillingRow, "status" | "graceUntil"> | undefined, anyWarning: boolean, now = Date.now()): BillingState {
  if (b?.status === "past_due") return b.graceUntil && b.graceUntil.getTime() > now ? "grace" : "restricted";
  if (b?.status === "canceled") return "canceled";
  return anyWarning ? "warning" : "ok";
}

export interface BillingDeps { cfg: Config; db: Db; providers: Providers; log: Logger }

export function billingRoutes({ cfg, db, providers, log }: BillingDeps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(cfg);
  const billing = providers.billing;
  const purchasable = () => (billing.checkoutPlans ? billing.checkoutPlans() : ["pro"]).filter((p) => p !== "free" && p !== "self_hosted");

  r.get("/billing", auth, requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const out = await withTenant(db, tenantId, async (tx) => {
      const [t] = await tx<{ planKey: string; planName: string }[]>`
        SELECT t.plan_key, p.name AS plan_name FROM tenants t JOIN plans p ON p.key = t.plan_key WHERE t.id = ${tenantId}`;
      const [b] = await tx<BillingRow[]>`SELECT * FROM billing_customers WHERE tenant_id = ${tenantId}`;
      const limits = await Promise.all(LIMIT_METRICS.map((m) => checkLimit(tx, tenantId, m)));
      return { t, b, limits };
    });
    if (!out.t) throw Errors.notFound();
    return c.json({
      provider: billing.name,
      plan: { key: out.t.planKey, name: out.t.planName },
      state: billingState(out.b, out.limits.some((l) => l.warning)),
      subscription: {
        status: out.b?.status ?? "none",
        currentPeriodEnd: out.b?.currentPeriodEnd?.toISOString() ?? null,
        graceUntil: out.b?.graceUntil?.toISOString() ?? null,
        cancelAtPeriodEnd: out.b?.cancelAtPeriodEnd ?? false,
      },
      limits: out.limits.map((l) => ({ metric: l.metric, limit: l.limit, used: l.used, warning: l.warning })),
      checkoutPlans: purchasable(),
    });
  });

  /** Existing provider customer, or create one (provider call happens outside the DB transaction). */
  async function ensureCustomer(tenantId: string, userId: string): Promise<BillingRow> {
    const existing = await withTenant(db, tenantId, async (tx) => (await tx<BillingRow[]>`SELECT * FROM billing_customers WHERE tenant_id = ${tenantId}`)[0]);
    if (existing) return existing;
    const who = await withTenant(db, tenantId, async (tx) => {
      const [u] = await tx<{ email: string }[]>`SELECT email FROM users WHERE tenant_id = ${tenantId} AND id = ${userId}`;
      const [t] = await tx<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${tenantId}`;
      return { email: u?.email, name: t?.name };
    });
    if (!who.email || !who.name) throw Errors.notFound();
    const { customerId } = await billing.createCustomer({ tenantId, email: who.email, name: who.name });
    return withTenant(db, tenantId, async (tx) => {
      await tx`INSERT INTO billing_customers (tenant_id, customer_id) VALUES (${tenantId}, ${customerId}) ON CONFLICT (tenant_id) DO NOTHING`;
      return (await tx<BillingRow[]>`SELECT * FROM billing_customers WHERE tenant_id = ${tenantId}`)[0]!;
    });
  }

  const providerCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof ProviderError) {
        log.error("billing provider error", { provider: e.provider, status: e.status, err: e.message });
        throw new AppError(503, "service_unavailable", "Billing provider unavailable");
      }
      throw e;
    }
  };

  r.post("/billing/checkout", auth, requireRole("owner"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const body = await parseBody(c, z.strictObject({ plan: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) }));
    if (!purchasable().includes(body.plan)) throw Errors.validation([{ path: "plan", message: "Plan is not available for checkout" }]);
    const cur = await withTenant(db, tenantId, async (tx) => (await tx<{ planKey: string }[]>`SELECT plan_key FROM tenants WHERE id = ${tenantId}`)[0]);
    const existing = await withTenant(db, tenantId, async (tx) => (await tx<BillingRow[]>`SELECT * FROM billing_customers WHERE tenant_id = ${tenantId}`)[0]);
    if (cur?.planKey === body.plan && (existing?.status === "active" || existing?.status === "trialing")) throw Errors.conflict("Already subscribed to this plan");
    const cust = await providerCall(() => ensureCustomer(tenantId, userId));
    const { url } = await providerCall(() => billing.createCheckoutSession({
      customerId: cust.customerId, planKey: body.plan, tenantId,
      successUrl: `${cfg.appUrl}/settings/billing?checkout=success`, cancelUrl: `${cfg.appUrl}/settings/billing?checkout=cancelled`,
    }));
    await withTenant(db, tenantId, (tx) => audit(tx, c, "billing.checkout_started", "tenant", tenantId, { plan: body.plan }));
    return c.json({ url });
  });

  mountCreditBilling(r, { cfg, db, billing, auth, ensureCustomer, providerCall });

  r.post("/billing/portal", auth, requireRole("owner"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await withTenant(db, tenantId, async (tx) => (await tx<BillingRow[]>`SELECT * FROM billing_customers WHERE tenant_id = ${tenantId}`)[0]);
    if (!b) throw Errors.conflict("No billing account yet; start a checkout first");
    const { url } = await providerCall(() => billing.createPortalSession({ customerId: b.customerId, returnUrl: `${cfg.appUrl}/settings/billing` }));
    return c.json({ url });
  });

  r.post("/billing/cancel", auth, requireRole("owner"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await withTenant(db, tenantId, async (tx) => (await tx<BillingRow[]>`SELECT * FROM billing_customers WHERE tenant_id = ${tenantId}`)[0]);
    if (!b?.subscriptionId) throw Errors.conflict("No active subscription");
    await providerCall(() => billing.cancelSubscription(b.subscriptionId!));
    await withTenant(db, tenantId, (tx) => audit(tx, c, "billing.cancel_requested", "tenant", tenantId, {}));
    return c.json({ ok: true as const });
  });

  // ---- usage history (any role)
  r.get("/usage", auth, async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
    const out = await withTenant(db, tenantId, async (tx) => {
      const series = await tx<{ day: string; metric: string; value: string }[]>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, value FROM usage_daily
        WHERE tenant_id = ${tenantId} AND day >= (now() AT TIME ZONE 'UTC')::date - ${q.days}::int ORDER BY day, metric`;
      const limits = await Promise.all(LIMIT_METRICS.map((m) => checkLimit(tx, tenantId, m)));
      return { series, limits };
    });
    return c.json({
      limits: out.limits.map((l) => ({ metric: l.metric, limit: l.limit, used: l.used, warning: l.warning })),
      series: out.series.map((s) => ({ day: s.day, metric: s.metric, value: Number(s.value) })),
    });
  });

  // ---- audit log export (admin+)
  r.get("/audit-logs/export", auth, requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, z.object({
      format: z.enum(["csv", "json"]).default("csv"), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
    }));
    const rows = await withTenant(db, tenantId, async (tx) => {
      const data = await tx<{ id: string; createdAt: Date; actorUserId: string | null; action: string; resourceType: string | null; resourceId: string | null; ip: string | null; requestId: string | null; metadata: unknown }[]>`
        SELECT id, created_at, actor_user_id, action, resource_type, resource_id, ip, request_id, metadata FROM audit_logs
        WHERE tenant_id = ${tenantId}
          ${q.from ? tx`AND created_at >= ${q.from}::timestamptz` : tx``}
          ${q.to ? tx`AND created_at <= ${q.to}::timestamptz` : tx``}
        ORDER BY created_at DESC, id DESC LIMIT 50000`;
      await audit(tx, c, "audit.exported", "audit_log", tenantId, { format: q.format, rows: data.length });
      return data;
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="audit-logs-${stamp}.${q.format}"` };
    if (q.format === "json") {
      return new Response(JSON.stringify({ items: rows.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })) }), {
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const csv = toCsv(
      ["id", "createdAt", "actorUserId", "action", "resourceType", "resourceId", "ip", "requestId", "metadata"],
      rows.map((x) => [x.id, x.createdAt.toISOString(), x.actorUserId, x.action, x.resourceType, x.resourceId, x.ip, x.requestId, x.metadata]),
    );
    return new Response(csv, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  });

  // ---- provider webhook (public; signature-verified; idempotent)
  r.post("/webhooks/billing", async (c) => {
    if (billing.name === "stub" && cfg.isProd) throw Errors.notFound();
    const raw = await c.req.text();
    let ev;
    try {
      ev = await billing.parseWebhook(raw, c.req.header("stripe-signature") ?? c.req.header("x-billing-signature") ?? null);
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw Errors.validation([{ path: "signature", message: "Invalid webhook" }]);
      if (e instanceof SyntaxError) throw Errors.validation([{ path: "body", message: "Invalid JSON" }]);
      throw e;
    }
    if (!ev.action) return c.json({ ok: true as const, ignored: true });
    if (ev.action === "credit_topup") {
      const res = await applyCreditTopup(db, ev, log);
      return c.json(res === "duplicate" ? { ok: true as const, duplicate: true } : res === "unknown_tenant" ? { ok: true as const, ignored: true } : { ok: true as const });
    }
    if (!ev.id) throw Errors.validation([{ path: "id", message: "Missing event id" }]);
    const tenantId = ev.tenantId && /^[0-9a-f-]{36}$/i.test(ev.tenantId) ? ev.tenantId : null;
    const [res] = await db<{ billingApplyEvent: string }[]>`
      SELECT billing_apply_event(${ev.id}, ${ev.type}, ${ev.action}, ${tenantId}, ${ev.customerId ?? null}, ${ev.subscriptionId ?? null},
        ${ev.planKey ?? null}, ${ev.status ?? null}, ${ev.periodEnd ?? null}, ${ev.cancelAtPeriodEnd ?? null}, ${GRACE_DAYS()})`;
    const result = res?.billingApplyEvent;
    if (result === "duplicate") return c.json({ ok: true as const, duplicate: true });
    if (result === "unknown_tenant") log.warn("billing webhook for unknown tenant", { type: ev.type, eventId: ev.id });
    return c.json({ ok: true as const, ...(result === "unknown_tenant" ? { ignored: true } : {}) });
  });

  return r;
}
