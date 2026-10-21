// Credit-pack purchases (SaaS billing router): pack list, checkout, and the webhook top-up.
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { withTenant, type Db } from "@yulona/db";
import type { BillingEvent, BillingProvider } from "@yulona/providers";
import type { Logger } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireMinRole } from "../platform/authz";
import { audit } from "../platform/util";

const MICRO = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PackRow { id: string; name: string; credits: string; priceCents: number; currency: string }

export function mountCreditBilling(r: Hono<AppEnv>, o: {
  cfg: Config; db: Db; billing: BillingProvider; auth: MiddlewareHandler<AppEnv>;
  ensureCustomer: (tenantId: string, userId: string) => Promise<{ customerId: string }>;
  providerCall: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const { cfg, db, billing, auth } = o;

  r.get("/billing/credit-packs", auth, requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => tx<PackRow[]>`SELECT id, name, credits, price_cents, currency FROM credit_packs WHERE active ORDER BY sort_order, price_cents, id`);
    return c.json({ items: rows.map((p) => ({ id: p.id, name: p.name, credits: Number(p.credits), priceCents: p.priceCents, currency: p.currency })) });
  });

  r.post("/billing/credits/checkout", auth, requireMinRole("admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const body = await parseBody(c, z.strictObject({ packId: z.string().uuid() }));
    const pack = await withTenant(db, tenantId, async (tx) => (await tx<PackRow[]>`SELECT id, name, credits, price_cents, currency FROM credit_packs WHERE id = ${body.packId} AND active`)[0]);
    if (!pack) throw Errors.notFound("Credit pack not found");
    if (!billing.createCreditCheckout) throw Errors.notFound("Credit purchases are not available");
    const cust = await o.providerCall(() => o.ensureCustomer(tenantId, userId));
    const { url } = await o.providerCall(() => billing.createCreditCheckout!({
      customerId: cust.customerId, tenantId, pack: { id: pack.id, name: pack.name, credits: Number(pack.credits), priceCents: pack.priceCents, currency: pack.currency },
      successUrl: `${cfg.appUrl}/settings/billing?credits=success`, cancelUrl: `${cfg.appUrl}/settings/billing?credits=cancelled`,
    }));
    await withTenant(db, tenantId, (tx) => audit(tx, c, "billing.credits_checkout_started", "credit_pack", pack.id, { credits: Number(pack.credits), priceCents: pack.priceCents }));
    return c.json({ url });
  });
}

/** Webhook side: credit the tenant (idempotent on the checkout session). Returns the SQL result. */
export async function applyCreditTopup(db: Db, ev: BillingEvent, log: Logger): Promise<"applied" | "duplicate" | "unknown_tenant"> {
  const t = ev.topup;
  const tenantId = ev.tenantId && UUID.test(ev.tenantId) ? ev.tenantId : null;
  if (!t?.ref || !tenantId || !Number.isInteger(t.credits) || t.credits <= 0 || t.credits > 10_000_000) {
    log.warn("credit top-up webhook ignored (bad payload)", { eventId: ev.id });
    return "unknown_tenant";
  }
  const packId = t.packId && UUID.test(t.packId) ? t.packId : null;
  const [res] = await db<{ creditsApplyTopup: "applied" | "duplicate" | "unknown_tenant" }[]>`
    SELECT credits_apply_topup(${t.ref}, ${tenantId}::uuid, ${packId}::uuid, ${t.credits * MICRO}::bigint, ${t.amountCents ?? null}::integer)`;
  return res!.creditsApplyTopup;
}
