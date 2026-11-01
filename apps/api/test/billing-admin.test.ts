import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { StripeBillingProvider, createMockProviders } from "@yulona/providers";
import { createApp } from "../src/app";
import { checkLimit } from "../src/platform/limits";
import { MemoryRateLimiter } from "../src/ratelimit";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const WH = "whsec_test_billing";

describe.skipIf(!hasDb)("billing + plan enforcement", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let app: ReturnType<typeof createApp>;
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
    const cfg = testConfig({}, (c) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; });
    const billing = new StripeBillingProvider({ secretKey: "sk_test", webhookSecret: WH, prices: { pro: "price_pro" }, fetch: fakeFetch });
    app = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }), providers: { ...createMockProviders(), billing } });
  });
  afterAll(async () => { limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  const call = (method: string, path: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(`/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = async <T = any>(r: Response) => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

  async function newTenant(plan = "free") {
    const e = uniqueEmail("own");
    const res = await app.request("/api/v1/auth/register", json({ email: e, password: PASSWORD, name: "Owner", workspaceName: "WS" }));
    const s = await j<{ accessToken: string; tenant: { id: string }; user: { id: string } }>(res);
    await owner`UPDATE tenants SET plan_key = ${plan} WHERE id = ${s.tenant.id}`;
    return { token: s.accessToken, tenantId: s.tenant.id, userId: s.user.id, email: e };
  }
  async function addAdmin(t: { token: string }) {
    const e = uniqueEmail("adm");
    const inv = await j<{ inviteUrl: string }>(await call("POST", "/invitations", t.token, { email: e, role: "admin" }));
    const token = new URL(inv.inviteUrl).searchParams.get("token")!;
    await app.request("/api/v1/invitations/accept", json({ token, name: "Adm", password: PASSWORD }));
    const r = await app.request("/api/v1/auth/login", json({ email: e, password: PASSWORD }));
    return (await j<{ accessToken: string }>(r)).accessToken;
  }
  const signed = (obj: unknown, key = WH, t = Math.floor(Date.now() / 1000)) => {
    const body = JSON.stringify(obj);
    return { body, headers: { "stripe-signature": `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`, "content-type": "application/json" } };
  };
  const hook = (obj: unknown, key?: string) => { const s = signed(obj, key); return app.request("/api/v1/webhooks/billing", { method: "POST", body: s.body, headers: s.headers }); };
  const subEvent = (id: string, customer: string, status: string, plan = "pro", tenantId?: string) => ({
    id, type: "customer.subscription.updated",
    data: { object: { id: "sub_1", customer, status, cancel_at_period_end: false, current_period_end: 1900000000, metadata: { planKey: plan, ...(tenantId ? { tenantId } : {}) } } },
  });

  test("auth required everywhere; role gates", async () => {
    for (const [m, p] of [["GET", "/billing"], ["POST", "/billing/checkout"], ["POST", "/billing/portal"], ["POST", "/billing/cancel"], ["GET", "/usage"], ["GET", "/audit-logs/export"]] as const) {
      expect([p, (await call(m, p, null, m === "POST" ? {} : undefined)).status]).toEqual([p, 401]);
    }
    const t = await newTenant();
    const adm = await addAdmin(t);
    expect((await call("POST", "/billing/checkout", adm, { plan: "pro" })).status).toBe(403); // owner only
    expect((await call("GET", "/billing", adm)).status).toBe(200);
  });

  test("checkout/portal/cancel flow + webhook sync, idempotency, grace, restore", async () => {
    const a = await newTenant();
    const b = await newTenant();
    expect((await call("POST", "/billing/checkout", a.token, { plan: "enterprise" })).status).toBe(400);
    expect((await call("POST", "/billing/checkout", a.token, { plan: "pro", extra: 1 })).status).toBe(400);
    expect((await call("POST", "/billing/portal", a.token, {})).status).toBe(409); // no customer yet
    const co = await call("POST", "/billing/checkout", a.token, { plan: "pro" });
    expect(co.status).toBe(200);
    expect((await j(co)).url).toBe("https://stripe.test/checkout");
    const [cust] = await owner<{ customer_id: string }[]>`SELECT customer_id FROM billing_customers WHERE tenant_id = ${a.tenantId}`;
    expect(cust).toBeTruthy();
    expect((await call("POST", "/billing/portal", a.token, {})).status).toBe(200);

    let st = await j(await call("GET", "/billing", a.token));
    expect(st).toMatchObject({ provider: "stripe", plan: { key: "free" }, state: "ok", subscription: { status: "none" }, checkoutPlans: ["pro"] });

    // bad / missing signature
    expect((await hook(subEvent("evt_bad", cust!.customer_id, "active"), "wrong")).status).toBe(400);
    expect((await app.request("/api/v1/webhooks/billing", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);

    const ev = subEvent("evt_" + crypto.randomUUID(), cust!.customer_id, "active");
    const r1 = await hook(ev);
    expect(r1.status).toBe(200);
    const r2 = await hook(ev);
    expect(await j(r2)).toMatchObject({ duplicate: true });
    st = await j(await call("GET", "/billing", a.token));
    expect(st).toMatchObject({ plan: { key: "pro" }, subscription: { status: "active", cancelAtPeriodEnd: false } });
    expect(st.subscription.currentPeriodEnd).toBe(new Date(1900000000 * 1000).toISOString());
    // tenant B untouched (cross-tenant)
    expect((await j(await call("GET", "/billing", b.token))).plan.key).toBe("free");
    const [bRow] = await owner`SELECT 1 FROM billing_customers WHERE tenant_id = ${b.tenantId}`;
    expect(bRow).toBeUndefined();

    // payment failure => grace (plan kept), then expiry => downgrade, then recovery
    await hook({ id: "evt_" + crypto.randomUUID(), type: "invoice.payment_failed", data: { object: { customer: cust!.customer_id } } });
    st = await j(await call("GET", "/billing", a.token));
    expect(st).toMatchObject({ state: "grace", plan: { key: "pro" }, subscription: { status: "past_due" } });
    expect(new Date(st.subscription.graceUntil).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await owner`UPDATE billing_customers SET grace_until = now() - interval '1 minute' WHERE tenant_id = ${a.tenantId}`;
    const [exp] = await owner<{ n: number }[]>`SELECT billing_expire_grace() AS n`;
    expect(exp!.n).toBeGreaterThanOrEqual(1);
    st = await j(await call("GET", "/billing", a.token));
    expect(st).toMatchObject({ state: "restricted", plan: { key: "free" } });
    await hook(subEvent("evt_" + crypto.randomUUID(), cust!.customer_id, "active"));
    st = await j(await call("GET", "/billing", a.token));
    expect(st).toMatchObject({ plan: { key: "pro" }, subscription: { status: "active", graceUntil: null } });

    // cancellation
    await owner`UPDATE billing_customers SET subscription_id = 'sub_1' WHERE tenant_id = ${a.tenantId}`;
    expect((await call("POST", "/billing/cancel", a.token, {})).status).toBe(200);
    await hook({ id: "evt_" + crypto.randomUUID(), type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: cust!.customer_id } } });
    st = await j(await call("GET", "/billing", a.token));
    expect(st).toMatchObject({ state: "canceled", plan: { key: "free" } });
    // unknown customer is acknowledged and ignored
    const unk = await hook(subEvent("evt_" + crypto.randomUUID(), "cus_nobody", "active"));
    expect(await j(unk)).toMatchObject({ ignored: true });
    // webhook is audited on the tenant side
    const audits = await owner`SELECT action FROM audit_logs WHERE tenant_id = ${a.tenantId} AND action LIKE 'billing.%'`;
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(["billing.subscription_set", "billing.payment_failed", "billing.grace_expired", "billing.subscription_deleted"]));
  });

  test("plan enforcement: widgets, storage, monthly conversations (live counts)", async () => {
    await owner`INSERT INTO plans (key, name) VALUES ('tiny','Tiny') ON CONFLICT DO NOTHING`;
    await owner`INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES ('tiny','widgets',1),('tiny','storage_mb',1),('tiny','monthly_conversations',2) ON CONFLICT DO NOTHING`;
    const t = await newTenant("tiny");
    const w1 = await call("POST", "/widgets", t.token, { name: "one" });
    expect(w1.status).toBe(201);
    const w2 = await call("POST", "/widgets", t.token, { name: "two" });
    expect(w2.status).toBe(402);
    expect((await j(w2)).error).toMatchObject({ code: "plan_limit_exceeded", details: { metric: "widgets", limit: 1, used: 1 } });
    // storage: 2 MB text source on a 1 MB plan
    const big = await call("POST", "/knowledge/sources/text", t.token, { name: "big", text: "x".repeat(2 * 1024 * 1024) });
    expect([402, 413]).toContain(big.status); // body limit (413) may trigger first; 402 asserted via checkLimit below
    const small = await call("POST", "/knowledge/sources/text", t.token, { name: "s", text: "hi" });
    expect(small.status).toBe(201); // sub-MB sources are not blocked by rounding while under the limit
    await owner`INSERT INTO knowledge_sources (tenant_id, type, name, size_bytes, status) VALUES (${t.tenantId}, 'text', 'seed', ${3 * 1048576}, 'ready')`;
    const sc = await checkLimit(db, t.tenantId, "storage_mb", 1);
    expect(sc).toMatchObject({ used: 4, allowed: false });
    const over = await call("POST", "/knowledge/sources/text", t.token, { name: "s2", text: "hi" });
    expect(over.status).toBe(402);
    expect((await j(over)).error.details).toMatchObject({ metric: "storage_mb", limit: 1 });
    // monthly conversations count live rows from this month only
    const [c1] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${t.tenantId}) RETURNING id`;
    await owner`INSERT INTO conversations (tenant_id, contact_id) VALUES (${t.tenantId}, ${c1!.id}), (${t.tenantId}, ${c1!.id})`;
    await owner`INSERT INTO conversations (tenant_id, contact_id, created_at) VALUES (${t.tenantId}, ${c1!.id}, now() - interval '70 days')`;
    expect(await checkLimit(db, t.tenantId, "monthly_conversations", 1)).toMatchObject({ used: 2, allowed: false });
    // public widget conversation start is blocked with 402
    const [wk] = await owner<{ widget_key: string }[]>`SELECT widget_key FROM widgets WHERE tenant_id = ${t.tenantId} LIMIT 1`;
    const start = await app.request("/api/v1/public/widget/conversations", { method: "POST", headers: { "content-type": "application/json", "x-widget-key": wk!.widget_key, origin: "http://localhost:5173" }, body: "{}" });
    expect(start.status).toBe(402);
    expect((await j(start)).error.details).toMatchObject({ metric: "monthly_conversations", limit: 2 });
  });

  test("usage rollup feeds /usage; tenants are isolated", async () => {
    const a = await newTenant("enterprise");
    const b = await newTenant("enterprise");
    const [c] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${a.tenantId}) RETURNING id`;
    const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id) VALUES (${a.tenantId}, ${c!.id}) RETURNING id`;
    await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${a.tenantId}, ${cv!.id}, 'contact', 'hi'), (${a.tenantId}, ${cv!.id}, 'note', 'n')`;
    const today = new Date().toISOString().slice(0, 10);
    await owner`SELECT usage_rollup(${today}::date, ${today}::date)`;
    const u = await j<{ series: { day: string; metric: string; value: number }[] }>(await call("GET", "/usage?days=7", a.token));
    const val = (m: string) => u.series.find((s) => s.metric === m && s.day === today)?.value;
    expect([val("conversations"), val("messages"), val("new_contacts")]).toEqual([1, 1, 1]); // notes excluded
    expect((await j<{ series: unknown[] }>(await call("GET", "/usage", b.token))).series).toHaveLength(0);
    expect((await call("GET", "/usage?days=0", a.token)).status).toBe(400);
  });

  test("audit export: csv + json, tenant-scoped, injection-safe, audited", async () => {
    const a = await newTenant("enterprise");
    const b = await newTenant();
    await owner`INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata) VALUES (${a.tenantId}, 'test.evil', 'x', '=cmd|calc', ${owner.json({ note: 'a,"b"' })})`;
    await owner`INSERT INTO audit_logs (tenant_id, action) VALUES (${b.tenantId}, 'test.other_tenant_secret')`;
    const csv = await call("GET", "/audit-logs/export?format=csv", a.token);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("id,createdAt,actorUserId,action,resourceType,resourceId,ip,requestId,metadata");
    expect(text).toContain("'=cmd|calc");
    expect(text).not.toContain("test.other_tenant_secret");
    const js = await j<{ items: { action: string }[] }>(await call("GET", "/audit-logs/export?format=json", a.token));
    expect(js.items.some((x) => x.action === "test.evil")).toBe(true);
    expect(js.items.some((x) => x.action === "audit.exported")).toBe(true); // export is audited
    expect((await call("GET", "/audit-logs/export?format=xml", a.token)).status).toBe(400);
    const adm = await addAdmin(a);
    expect((await call("GET", "/audit-logs/export", adm)).status).toBe(200);
    const agentRes = await call("POST", "/invitations", a.token, { email: uniqueEmail("v"), role: "viewer" });
    const vTok = new URL((await j<{ inviteUrl: string }>(agentRes)).inviteUrl).searchParams.get("token")!;
    const vEmail = (await owner<{ email: string }[]>`SELECT email FROM invitations WHERE tenant_id = ${a.tenantId} AND role = 'viewer'`)[0]!.email;
    await app.request("/api/v1/invitations/accept", json({ token: vTok, name: "V", password: PASSWORD }));
    const viewer = (await j<{ accessToken: string }>(await app.request("/api/v1/auth/login", json({ email: vEmail, password: PASSWORD })))).accessToken;
    expect((await call("GET", "/audit-logs/export", viewer)).status).toBe(403);
  });

  test("stub provider webhook is rejected in production config", async () => {
    const cfg = testConfig({}, (c) => { (c as { isProd: boolean }).isProd = true; });
    const a2 = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }), providers: createMockProviders() });
    const r = await a2.request("/api/v1/webhooks/billing", { method: "POST", body: JSON.stringify({ id: "e", type: "x", action: "payment_failed", customerId: "c" }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(404);
  });
});
