import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { StripeBillingProvider, stripeFromEnv } from "../src/stripe";

const secret = "whsec_test";
const sign = (body: string, t = Math.floor(Date.now() / 1000), key = secret) =>
  `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
const mk = (f?: typeof fetch) => new StripeBillingProvider({ secretKey: "sk_test_x", webhookSecret: secret, prices: { pro: "price_pro" }, fetch: f });

describe("stripe provider", () => {
  test("verifies signatures, rejects tampered/stale/missing", async () => {
    const p = mk();
    const body = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed", data: { object: { customer: "cus_1" } } });
    const ev = await p.parseWebhook(body, sign(body));
    expect(ev).toMatchObject({ id: "evt_1", action: "payment_failed", customerId: "cus_1" });
    await expect(p.parseWebhook(body + " ", sign(body))).rejects.toThrow(/signature/);
    await expect(p.parseWebhook(body, sign(body, undefined, "other"))).rejects.toThrow(/signature/);
    await expect(p.parseWebhook(body, sign(body, Math.floor(Date.now() / 1000) - 3600))).rejects.toThrow(/tolerance/);
    await expect(p.parseWebhook(body, null)).rejects.toThrow(/missing/);
    await expect(p.parseWebhook(body, "t=abc,v1=zz")).rejects.toThrow();
  });

  test("maps subscription events", async () => {
    const p = mk();
    const body = JSON.stringify({ id: "evt_2", type: "customer.subscription.updated", data: { object: {
      id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: true, current_period_end: 1900000000,
      metadata: { tenantId: "t1" }, items: { data: [{ price: { id: "price_pro" } }] } } } });
    const ev = await p.parseWebhook(body, sign(body));
    expect(ev).toMatchObject({ action: "subscription_set", status: "active", subscriptionId: "sub_1", planKey: "pro", cancelAtPeriodEnd: true, tenantId: "t1" });
    expect(ev.periodEnd?.getTime()).toBe(1900000000 * 1000);
    const other = JSON.stringify({ id: "evt_3", type: "charge.refunded", data: { object: {} } });
    expect((await p.parseWebhook(other, sign(other))).action).toBeUndefined();
  });

  test("invoice events: newer API shape (parent.subscription_details), checkout with unpaid delayed payment", async () => {
    const p = mk();
    const inv = (type: string, object: object) => JSON.stringify({ id: "evt_" + type, type, data: { object } });
    const paid = inv("invoice.paid", { customer: "cus_1", parent: { subscription_details: { subscription: "sub_new" } } });
    expect(await p.parseWebhook(paid, sign(paid))).toMatchObject({ action: "payment_succeeded", customerId: "cus_1", subscriptionId: "sub_new" });
    const failed = inv("invoice.payment_failed", { customer: "cus_1", subscription: "sub_old" });
    expect(await p.parseWebhook(failed, sign(failed))).toMatchObject({ action: "payment_failed", subscriptionId: "sub_old" });
    const del = inv("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", metadata: { tenantId: "t1" } });
    expect(await p.parseWebhook(del, sign(del))).toMatchObject({ action: "subscription_deleted", subscriptionId: "sub_1", tenantId: "t1" });
    const unpaid = inv("checkout.session.completed", { mode: "subscription", payment_status: "unpaid", customer: "cus_1", subscription: "sub_1", client_reference_id: "t1" });
    expect((await p.parseWebhook(unpaid, sign(unpaid))).action).toBeUndefined();
    const ok = inv("checkout.session.completed", { mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1", client_reference_id: "t1", metadata: { planKey: "pro" } });
    expect(await p.parseWebhook(ok, sign(ok))).toMatchObject({ action: "subscription_set", status: "active", planKey: "pro", tenantId: "t1" });
  });

  test("REST calls: customer, checkout (price + tenant metadata), portal, errors", async () => {
    const calls: { url: string; body: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body ?? "") });
      if (url.endsWith("/v1/customers")) return Response.json({ id: "cus_9" });
      if (url.includes("/checkout/")) return Response.json({ url: "https://stripe.test/c" });
      return Response.json({ error: { message: "nope" } }, { status: 402 });
    }) as unknown as typeof fetch;
    const p = mk(f);
    expect((await p.createCustomer({ tenantId: "t1", email: "a@b.co", name: "A" })).customerId).toBe("cus_9");
    const s = await p.createCheckoutSession({ customerId: "cus_9", planKey: "pro", tenantId: "t1", successUrl: "https://a/s", cancelUrl: "https://a/c" });
    expect(s.url).toBe("https://stripe.test/c");
    expect(calls[1]!.body).toContain("line_items%5B0%5D%5Bprice%5D=price_pro");
    expect(calls[1]!.body).toContain("client_reference_id=t1");
    await expect(p.createCheckoutSession({ customerId: "c", planKey: "enterprise", successUrl: "x", cancelUrl: "y" })).rejects.toThrow(/no Stripe price/);
    await expect(p.createPortalSession({ customerId: "c", returnUrl: "x" })).rejects.toThrow(/stripe 402/);
  });

  test("stripeFromEnv", () => {
    expect(stripeFromEnv({})).toBeUndefined();
    const p = stripeFromEnv({ STRIPE_SECRET_KEY: "sk", STRIPE_PRICE_PRO: "price_1", STRIPE_PRICE_TEAM_PLUS: "price_2" })!;
    expect(p.checkoutPlans().sort()).toEqual(["pro", "team_plus"]);
  });
});
