// Wave 5 / C: the $49 plan mapping, message estimates, and the Stripe subscription lifecycle with signed fixture payloads.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { StripeBillingProvider, createMockProviders } from "@yulona/providers";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const WH = "whsec_test_plan49";
const MICRO = 1_000_000;

describe.skipIf(!hasDb)("$49 plan, message estimates, Stripe lifecycle", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let app: ReturnType<typeof createApp>;
  let sh: ReturnType<typeof createApp>;
  let limiter: MemoryRateLimiter;
  const stripeCalls: string[] = [];

  const fakeFetch = (async (url: string, init: RequestInit) => {
    stripeCalls.push(`${init.method} ${url}`);
    if (url.endsWith("/v1/customers")) return Response.json({ id: `cus_${crypto.randomUUID().slice(0, 8)}` });
    if (url.includes("/checkout/sessions")) return Response.json({ url: "https://stripe.test/checkout" });
    if (url.includes("/billing_portal/")) return Response.json({ url: "https://stripe.test/portal" });
    return Response.json({ id: "sub_x", status: "canceled" });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    const t = await setupTestDb();
    owner = t.owner; db = t.app;
    limiter = new MemoryRateLimiter();
    const open = (c: ReturnType<typeof testConfig>) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; };
    const log = createLogger({ level: "silent" });
    const billing = new StripeBillingProvider({ secretKey: "sk_test", webhookSecret: WH, prices: { pro: "price_pro" }, fetch: fakeFetch });
    app = createApp({ cfg: testConfig({}, open), db, limiter, log, providers: { ...createMockProviders(), billing } });
    sh = createApp({ cfg: testConfig({ DEPLOYMENT_MODE: "selfhosted" }, open), db, limiter, log, providers: createMockProviders() });
  });
  afterAll(async () => { limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  const call = (method: string, path: string, token: string, body?: unknown, a = app) =>
    a.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = async <T = any>(r: Response) => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
  async function newTenant(plan = "free") {
    const s = await j<{ accessToken: string; tenant: { id: string } }>(await app.request("/api/v1/auth/register", json({ email: uniqueEmail("own"), password: PASSWORD, name: "Owner", workspaceName: "WS" })));
    await owner`UPDATE tenants SET plan_key = ${plan} WHERE id = ${s.tenant.id}`;
    return { token: s.accessToken, tenantId: s.tenant.id };
  }
  const hook = (obj: unknown, key = WH) => {
    const body = JSON.stringify(obj), t = Math.floor(Date.now() / 1000);
    return app.request("/api/v1/webhooks/billing", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`, "content-type": "application/json" } });
  };
  const evt = (type: string, object: object) => ({ id: "evt_" + crypto.randomUUID(), type, data: { object } });
  const turns = (tenantId: string, n: number, credits: number, source = "turn") =>
    owner`INSERT INTO ai_usage_events (tenant_id, source, model, prompt_tokens, completion_tokens, credits_micro)
          SELECT ${tenantId}, ${source}, 'm', 100, 10, ${credits} FROM generate_series(1, ${n})`;

  test("migration 0960: pro = 4,980 credits / 15,480,000 tokens, matching the default rate", async () => {
    const lim = await owner<{ metric: string; limit_value: string }[]>`SELECT metric, limit_value FROM plan_limits WHERE plan_key = 'pro' AND metric IN ('llm_credits_monthly','llm_tokens_monthly')`;
    const by = Object.fromEntries(lim.map((l) => [l.metric, Number(l.limit_value)]));
    expect(by).toEqual({ llm_credits_monthly: 4980, llm_tokens_monthly: 15_480_000 });
    const [r] = await owner<{ i: string; o: string }[]>`SELECT input_micro_per_1k AS i, output_micro_per_1k AS o FROM llm_model_rates WHERE model = '*'`;
    // 14,000k prompt tokens at 0.25 + 1,480k completion tokens at 1.0 credits per 1k
    expect((14_000 * Number(r!.i) + 1_480 * Number(r!.o)) / MICRO).toBe(by.llm_credits_monthly!);
    expect(14_000_000 + 1_480_000).toBe(by.llm_tokens_monthly!);
    const [free] = await owner<{ v: string }[]>`SELECT limit_value AS v FROM plan_limits WHERE plan_key = 'free' AND metric = 'llm_credits_monthly'`;
    expect(Number(free!.v)).toBe(50);
  });

  test("GET /usage/credits estimates: typical message fallback, workspace average, ignores non-turn events", async () => {
    const t = await newTenant("pro");
    let c = await j(await call("GET", "/usage/credits", t.token));
    // typical message: 6k in x 0.25 + 0.6k out x 1.0 = 2.1 credits; 4980 / 2.1 = 2371 whole messages
    expect(c).toMatchObject({ allowanceMicro: 4980 * MICRO, creditsPerMessage: 2.1, estimateBasis: "typical", estimatedMessages: 2371 });
    await turns(t.tenantId, 9, 1 * MICRO); // below the sample threshold: still typical
    expect((await j(await call("GET", "/usage/credits", t.token))).estimateBasis).toBe("typical");
    await turns(t.tenantId, 20, 100 * MICRO, "sandbox"); // sandbox/builder calls are not answered customer messages
    expect((await j(await call("GET", "/usage/credits", t.token))).estimateBasis).toBe("typical");
    await turns(t.tenantId, 1, 1 * MICRO);
    c = await j(await call("GET", "/usage/credits", t.token));
    expect(c).toMatchObject({ creditsPerMessage: 1, estimateBasis: "usage" });
    expect(c.estimatedMessages).toBe(Math.floor(c.remainingMicro / MICRO));
    // old events fall out of the rolling window
    await owner`UPDATE ai_usage_events SET day = day - 60 WHERE tenant_id = ${t.tenantId}`;
    expect((await j(await call("GET", "/usage/credits", t.token))).estimateBasis).toBe("typical");
    // exhausted -> 0 messages
    await owner`UPDATE tenant_credits SET used_micro = allowance_micro WHERE tenant_id = ${t.tenantId}`;
    expect(await j(await call("GET", "/usage/credits", t.token))).toMatchObject({ status: "exhausted", estimatedMessages: 0 });
    // unlimited plan and self-hosted carry no estimate
    const ent = await newTenant("enterprise");
    expect(await j(await call("GET", "/usage/credits", ent.token))).toMatchObject({ unlimited: true, estimatedMessages: null, creditsPerMessage: null, estimateBasis: null });
  });

  test("subscription lifecycle: checkout, renewal, failed payment, late payment restores the plan, cancel, credit top-up", async () => {
    const t = await newTenant();
    const co = await call("POST", "/billing/checkout", t.token, { plan: "pro" });
    expect((await j(co)).url).toBe("https://stripe.test/checkout");
    const [cust] = await owner<{ customer_id: string }[]>`SELECT customer_id FROM billing_customers WHERE tenant_id = ${t.tenantId}`;
    const customer = cust!.customer_id;
    expect(await j(await call("GET", "/usage/credits", t.token))).toMatchObject({ allowanceMicro: 50 * MICRO });

    // 1. checkout.session.completed (subscription mode) activates Pro and its allowance
    expect((await hook(evt("checkout.session.completed", { id: "cs_1", mode: "subscription", payment_status: "paid", customer, subscription: "sub_49", client_reference_id: t.tenantId, metadata: { planKey: "pro", tenantId: t.tenantId } }))).status).toBe(200);
    let b = await j(await call("GET", "/billing", t.token));
    expect(b).toMatchObject({ plan: { key: "pro" }, subscription: { status: "active" } });
    expect(await j(await call("GET", "/usage/credits", t.token))).toMatchObject({ allowanceMicro: 4980 * MICRO, remainingMicro: 4980 * MICRO });

    // 2. renewal: subscription.updated moves the period end; invoice.paid (2025 API shape) keeps it active
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    await hook(evt("customer.subscription.updated", { id: "sub_49", customer, status: "active", cancel_at_period_end: false, items: { data: [{ price: { id: "price_pro" }, current_period_end: periodEnd }] } }));
    await hook(evt("invoice.paid", { customer, parent: { subscription_details: { subscription: "sub_49" } } }));
    b = await j(await call("GET", "/billing", t.token));
    expect(b.subscription.currentPeriodEnd).toBe(new Date(periodEnd * 1000).toISOString());
    expect(b).toMatchObject({ plan: { key: "pro" }, state: "ok" });

    // 3. monthly reset: a stale period row rolls over with the allowance back to full and the top-up balance kept
    await owner`UPDATE tenant_credits SET period = (period - interval '1 month')::date, used_micro = ${4000 * MICRO}, topup_micro = ${7 * MICRO} WHERE tenant_id = ${t.tenantId}`;
    const [ro] = await owner<{ n: number }[]>`SELECT credits_rollover() AS n`;
    expect(ro!.n).toBeGreaterThanOrEqual(1);
    expect(await j(await call("GET", "/usage/credits", t.token))).toMatchObject({ allowanceMicro: 4980 * MICRO, usedMicro: 0, topupMicro: 7 * MICRO });

    // 4. failed payment: grace keeps Pro; once the grace window passes the workspace drops to Free
    await hook(evt("invoice.payment_failed", { customer, parent: { subscription_details: { subscription: "sub_49" } } }));
    expect(await j(await call("GET", "/billing", t.token))).toMatchObject({ state: "grace", plan: { key: "pro" } });
    await owner`UPDATE billing_customers SET grace_until = now() - interval '1 minute' WHERE tenant_id = ${t.tenantId}`;
    await owner`SELECT billing_expire_grace()`;
    expect(await j(await call("GET", "/billing", t.token))).toMatchObject({ plan: { key: "free" }, state: "restricted" });
    expect((await j(await call("GET", "/usage/credits", t.token))).allowanceMicro).toBe(50 * MICRO);

    // 5. a late successful payment alone restores Pro (migration 0961)
    await hook(evt("invoice.paid", { customer, parent: { subscription_details: { subscription: "sub_49" } } }));
    expect(await j(await call("GET", "/billing", t.token))).toMatchObject({ plan: { key: "pro" }, state: "ok", subscription: { status: "active" } });
    expect((await j(await call("GET", "/usage/credits", t.token))).allowanceMicro).toBe(4980 * MICRO);

    // 6. credit pack top-up (once per checkout session), portal, cancel
    const topup = (id: string) => evt("checkout.session.completed", { id, mode: "payment", payment_status: "paid", customer, client_reference_id: t.tenantId, amount_total: 900, metadata: { kind: "credit_topup", packId: crypto.randomUUID(), credits: "500", tenantId: t.tenantId } });
    const session = "cs_pack_" + crypto.randomUUID();
    await hook(topup(session));
    await hook(topup(session));
    expect((await j(await call("GET", "/usage/credits", t.token))).topupMicro).toBe(507 * MICRO);
    expect((await call("POST", "/billing/portal", t.token, {})).status).toBe(200);
    expect((await call("POST", "/billing/cancel", t.token, {})).status).toBe(200);
    expect(stripeCalls).toContain("DELETE https://api.stripe.com/v1/subscriptions/sub_49");
    await hook(evt("customer.subscription.deleted", { id: "sub_49", customer }));
    expect(await j(await call("GET", "/billing", t.token))).toMatchObject({ plan: { key: "free" }, state: "canceled" });
    // bought credits survive the downgrade
    expect((await j(await call("GET", "/usage/credits", t.token))).topupMicro).toBe(507 * MICRO);

    // bad signature is rejected and changes nothing
    expect((await hook(evt("customer.subscription.updated", { id: "sub_49", customer, status: "active", metadata: { planKey: "pro" } }), "whsec_wrong")).status).toBe(400);
    expect((await j(await call("GET", "/billing", t.token))).plan.key).toBe("free");
  });

  test("self-hosted: no estimate fields populated", async () => {
    const [tn] = await owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('sh-est') RETURNING id`;
    const e = uniqueEmail("sh");
    const { hashPassword } = await import("../src/security");
    await owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tn!.id}, ${e}, 'O', 'owner', ${await hashPassword(PASSWORD)})`;
    const tok = (await j<{ accessToken: string }>(await sh.request("/api/v1/auth/login", json({ email: e, password: PASSWORD })))).accessToken;
    expect(await j(await call("GET", "/usage/credits", tok, undefined, sh))).toMatchObject({ enabled: false, estimatedMessages: null, creditsPerMessage: null });
  });
});
