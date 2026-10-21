import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderError, type BillingEvent, type BillingProvider } from "./types";

export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
  /** plan key -> Stripe price id */
  prices: Record<string, string>;
  apiBase?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Webhook timestamp tolerance (seconds). */
  toleranceSec?: number;
}

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Stripe over plain REST (no SDK): customers, Checkout, Billing Portal, cancel, webhook verification. */
export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe";
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly cfg: StripeConfig) {
    this.base = cfg.apiBase ?? "https://api.stripe.com";
    this.f = cfg.fetch ?? fetch;
  }

  checkoutPlans() { return Object.keys(this.cfg.prices); }

  private async call(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>): Promise<Obj> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.secretKey}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) {
      throw new ProviderError(`stripe ${res.status}: ${body.error?.message ?? "request failed"}`, "stripe", res.status >= 500 || res.status === 429, res.status);
    }
    return body;
  }

  async createCustomer(i: { tenantId: string; email: string; name: string }) {
    const c = await this.call("POST", "/v1/customers", { email: i.email, name: i.name, "metadata[tenantId]": i.tenantId });
    return { customerId: String(c.id) };
  }

  async createCheckoutSession(i: { customerId: string; planKey: string; successUrl: string; cancelUrl: string; tenantId?: string }) {
    const price = this.cfg.prices[i.planKey];
    if (!price) throw new ProviderError(`no Stripe price configured for plan ${i.planKey}`, "stripe", false);
    const s = await this.call("POST", "/v1/checkout/sessions", {
      mode: "subscription", customer: i.customerId,
      "line_items[0][price]": price, "line_items[0][quantity]": "1",
      success_url: i.successUrl, cancel_url: i.cancelUrl,
      "metadata[planKey]": i.planKey, "subscription_data[metadata][planKey]": i.planKey,
      ...(i.tenantId ? { client_reference_id: i.tenantId, "metadata[tenantId]": i.tenantId, "subscription_data[metadata][tenantId]": i.tenantId } : {}),
    });
    return { url: String(s.url) };
  }

  async createPortalSession(i: { customerId: string; returnUrl: string }) {
    const s = await this.call("POST", "/v1/billing_portal/sessions", { customer: i.customerId, return_url: i.returnUrl });
    return { url: String(s.url) };
  }

  async createCreditCheckout(i: {
    customerId: string; tenantId: string; pack: { id: string; name: string; credits: number; priceCents: number; currency: string };
    successUrl: string; cancelUrl: string;
  }) {
    const meta = { kind: "credit_topup", packId: i.pack.id, credits: String(i.pack.credits), tenantId: i.tenantId };
    const s = await this.call("POST", "/v1/checkout/sessions", {
      mode: "payment", customer: i.customerId,
      "line_items[0][price_data][currency]": i.pack.currency, "line_items[0][price_data][unit_amount]": String(i.pack.priceCents),
      "line_items[0][price_data][product_data][name]": `${i.pack.name}: ${i.pack.credits} AI credits`, "line_items[0][quantity]": "1",
      success_url: i.successUrl, cancel_url: i.cancelUrl, client_reference_id: i.tenantId,
      ...Object.fromEntries(Object.entries(meta).flatMap(([k, v]) => [[`metadata[${k}]`, v], [`payment_intent_data[metadata][${k}]`, v]])),
    });
    return { url: String(s.url) };
  }

  async cancelSubscription(subscriptionId: string) {
    await this.call("DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  private planOf(sub: Obj): string | undefined {
    if (sub.metadata?.planKey) return String(sub.metadata.planKey);
    const priceId = sub.items?.data?.[0]?.price?.id;
    return Object.entries(this.cfg.prices).find(([, id]) => id === priceId)?.[0];
  }

  /** Verify `Stripe-Signature` (t=...,v1=...) over `${t}.${raw}` with HMAC-SHA256; constant-time compare. */
  verifySignature(rawBody: string, header: string | null, now = Date.now()): void {
    const secret = this.cfg.webhookSecret;
    if (!secret) throw new ProviderError("webhook secret not configured", "stripe", false);
    if (!header) throw new ProviderError("missing signature", "stripe", false);
    const parts = header.split(",").map((p) => p.trim().split("=") as [string, string]);
    const t = parts.find(([k]) => k === "t")?.[1];
    const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
    if (!t || !/^\d+$/.test(t) || sigs.length === 0) throw new ProviderError("malformed signature", "stripe", false);
    if (Math.abs(now / 1000 - Number(t)) > (this.cfg.toleranceSec ?? 300)) throw new ProviderError("signature timestamp outside tolerance", "stripe", false);
    const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
    const ok = sigs.some((s) => {
      const b = Buffer.from(s, "hex");
      return b.length === expected.length && timingSafeEqual(b, expected);
    });
    if (!ok) throw new ProviderError("invalid signature", "stripe", false);
  }

  async parseWebhook(rawBody: string, signature: string | null): Promise<BillingEvent> {
    this.verifySignature(rawBody, signature);
    let ev: Obj;
    try { ev = JSON.parse(rawBody) as Obj; } catch { throw new ProviderError("invalid JSON", "stripe", false); }
    const o: Obj = ev.data?.object ?? {};
    const base: BillingEvent = { type: String(ev.type), id: String(ev.id), raw: ev };
    const periodEnd = (v: unknown) => (typeof v === "number" ? new Date(v * 1000) : undefined);
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (o.mode === "payment") {
          // credit pack purchase: only paid sessions credit; the session id is the idempotency key
          const credits = Number(o.metadata?.credits);
          if (o.metadata?.kind !== "credit_topup" || o.payment_status !== "paid" || !Number.isInteger(credits) || credits <= 0) return base;
          return {
            ...base, action: "credit_topup", customerId: o.customer, tenantId: o.client_reference_id ?? o.metadata?.tenantId,
            topup: { ref: String(o.id), packId: o.metadata?.packId, credits, amountCents: typeof o.amount_total === "number" ? o.amount_total : undefined },
          };
        }
        if (o.mode !== "subscription" || ev.type !== "checkout.session.completed") return base;
        return {
          ...base, action: "subscription_set", status: "active", customerId: o.customer, subscriptionId: o.subscription,
          tenantId: o.client_reference_id ?? o.metadata?.tenantId, planKey: o.metadata?.planKey,
        };
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
        return {
          ...base, action: "subscription_set", status: o.status, customerId: o.customer, subscriptionId: o.id, tenantId: o.metadata?.tenantId,
          planKey: this.planOf(o), periodEnd: periodEnd(o.current_period_end ?? o.items?.data?.[0]?.current_period_end), cancelAtPeriodEnd: !!o.cancel_at_period_end,
        };
      case "customer.subscription.deleted":
        return { ...base, action: "subscription_deleted", customerId: o.customer, subscriptionId: o.id, tenantId: o.metadata?.tenantId };
      case "invoice.payment_failed":
        return { ...base, action: "payment_failed", customerId: o.customer, subscriptionId: o.subscription };
      case "invoice.payment_succeeded":
      case "invoice.paid":
        return { ...base, action: "payment_succeeded", customerId: o.customer, subscriptionId: o.subscription };
      default:
        return base;
    }
  }
}

/** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_<PLAN>` (e.g. STRIPE_PRICE_PRO). */
export function stripeFromEnv(env: Record<string, string | undefined>): StripeBillingProvider | undefined {
  if (!env.STRIPE_SECRET_KEY) return undefined;
  const prices: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^STRIPE_PRICE_([A-Z][A-Z0-9_]*)$/.exec(k);
    if (m && v) prices[m[1]!.toLowerCase()] = v;
  }
  return new StripeBillingProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, prices, apiBase: env.STRIPE_API_BASE });
}
