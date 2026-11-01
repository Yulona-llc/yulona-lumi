import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { StripeBillingProvider, createMockProviders } from "@yulona/providers";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { hashPassword } from "../src/security";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const WH = "whsec_test_credits";
const ENC = "0123456789abcdef".repeat(4);
const MICRO = 1_000_000;

describe.skipIf(!hasDb)("credits + usage + provider config", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let app: ReturnType<typeof createApp>;
  let sh: ReturnType<typeof createApp>; // self-hosted deployment
  let limiter: MemoryRateLimiter;
  const stripeForms: Record<string, string>[] = [];

  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (init.body) stripeForms.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    if (url.endsWith("/v1/customers")) return Response.json({ id: `cus_${crypto.randomUUID().slice(0, 8)}` });
    if (url.includes("/checkout/sessions")) return Response.json({ id: "cs_1", url: "https://stripe.test/credits" });
    return Response.json({});
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    const t = await setupTestDb();
    owner = t.owner; db = t.app;
    limiter = new MemoryRateLimiter();
    const open = (c: ReturnType<typeof testConfig>) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; };
    const log = createLogger({ level: "silent" });
    const billing = new StripeBillingProvider({ secretKey: "sk_test", webhookSecret: WH, prices: { pro: "price_pro" }, fetch: fakeFetch });
    app = createApp({ cfg: testConfig({ ENCRYPTION_KEY: ENC }, open), db, limiter, log, providers: { ...createMockProviders(), billing } });
    sh = createApp({ cfg: testConfig({ ENCRYPTION_KEY: ENC, DEPLOYMENT_MODE: "selfhosted" }, open), db, limiter, log, providers: createMockProviders() });
  });
  afterAll(async () => {
    // pending credit emails would crowd the 25-row batch of the ops email-dispatch test sharing this database
    await owner`UPDATE notifications SET email_status = 'none' WHERE type LIKE 'credits.%' AND email_status = 'pending'`;
    limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  const call = (a: ReturnType<typeof createApp>, method: string, path: string, token: string | null, body?: unknown) =>
    a.request(`/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = async <T = any>(r: Response) => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

  async function newTenant(plan = "free") {
    const e = uniqueEmail("own");
    const s = await j<{ accessToken: string; tenant: { id: string } }>(await app.request("/api/v1/auth/register", json({ email: e, password: PASSWORD, name: "Owner", workspaceName: "WS" })));
    await owner`UPDATE tenants SET plan_key = ${plan} WHERE id = ${s.tenant.id}`;
    return { token: s.accessToken, tenantId: s.tenant.id };
  }
  async function addUser(t: { token: string }, role: string) {
    const e = uniqueEmail(role);
    const inv = await j<{ inviteUrl: string }>(await call(app, "POST", "/invitations", t.token, { email: e, role }));
    await app.request("/api/v1/invitations/accept", json({ token: new URL(inv.inviteUrl).searchParams.get("token")!, name: "U", password: PASSWORD }));
    return (await j<{ accessToken: string }>(await app.request("/api/v1/auth/login", json({ email: e, password: PASSWORD })))).accessToken;
  }
  async function shTenantToken() {
    const [tn] = await owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('sh-' || substr(gen_random_uuid()::text, 1, 6)) RETURNING id`;
    const e = uniqueEmail("sh");
    await owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tn!.id}, ${e}, 'O', 'owner', ${await hashPassword(PASSWORD)})`;
    const token = (await j<{ accessToken: string }>(await sh.request("/api/v1/auth/login", json({ email: e, password: PASSWORD })))).accessToken;
    return { token, tenantId: tn!.id };
  }
  const event = (tenantId: string, over: { agent?: string | null; model?: string; conv?: string | null; day?: string; p?: number; c?: number; credits?: number; source?: string } = {}) =>
    owner`INSERT INTO ai_usage_events (tenant_id, agent_id, conversation_id, model, source, day, prompt_tokens, completion_tokens, credits_micro)
          VALUES (${tenantId}, ${over.agent ?? null}, ${over.conv === undefined ? null : over.conv}, ${over.model ?? "m1"}, ${over.source ?? "turn"}, ${over.day ?? new Date().toISOString().slice(0, 10)},
                  ${over.p ?? 100}, ${over.c ?? 50}, ${over.credits ?? 1000})`;
  const signed = (obj: unknown) => {
    const body = JSON.stringify(obj), t = Math.floor(Date.now() / 1000);
    return { body, headers: { "stripe-signature": `t=${t},v1=${createHmac("sha256", WH).update(`${t}.${body}`).digest("hex")}`, "content-type": "application/json" } };
  };
  const hook = (obj: unknown) => { const s = signed(obj); return app.request("/api/v1/webhooks/billing", { method: "POST", body: s.body, headers: s.headers }); };
  const topupEvent = (tenantId: string, session: string, credits: number, over: { evt?: string; type?: string; paid?: boolean; kind?: string } = {}) => ({
    id: over.evt ?? "evt_" + crypto.randomUUID(), type: over.type ?? "checkout.session.completed",
    data: { object: { id: session, mode: "payment", payment_status: over.paid === false ? "unpaid" : "paid", customer: "cus_x", client_reference_id: tenantId, amount_total: credits * 2,
      metadata: { kind: over.kind ?? "credit_topup", packId: crypto.randomUUID(), credits: String(credits), tenantId } } },
  });

  test("auth required everywhere; role gates", async () => {
    const id = crypto.randomUUID();
    for (const [m, p] of [["GET", "/usage/credits"], ["GET", "/usage/ai"], ["GET", "/usage/ai/export"], ["GET", "/billing/credit-packs"], ["POST", "/billing/credits/checkout"]] as const) {
      expect([p, (await call(app, m, p, null, m === "POST" ? {} : undefined)).status]).toEqual([p, 401]);
    }
    const t = await newTenant("pro"); // free plans only have 2 seats
    expect((await call(app, "GET", "/admin/llm-profiles", t.token)).status).toBe(404); // platform administration is not served here
    const agent = await addUser(t, "agent");
    expect((await call(app, "GET", "/usage/credits", agent)).status).toBe(200);
    expect((await call(app, "GET", "/usage/ai", agent)).status).toBe(403);
    expect((await call(app, "GET", "/billing/credit-packs", agent)).status).toBe(403);
    expect((await call(app, "POST", "/billing/credits/checkout", agent, { packId: crypto.randomUUID() })).status).toBe(403);
    const admin = await addUser(t, "admin");
    expect((await call(app, "GET", "/usage/ai", admin)).status).toBe(200);
  });

  test("GET /usage/credits: allowance from the plan, warning and exhausted states", async () => {
    const t = await newTenant();
    let c = await j(await call(app, "GET", "/usage/credits", t.token));
    expect(c).toMatchObject({ mode: "saas", enabled: true, unlimited: false, allowanceMicro: 50 * MICRO, usedMicro: 0, topupMicro: 0, remainingMicro: 50 * MICRO, percentUsed: 0, status: "ok", warnings: [] });
    expect(c.period).toBe(new Date().toISOString().slice(0, 7) + "-01");
    await owner`UPDATE tenant_credits SET used_micro = ${42 * MICRO} WHERE tenant_id = ${t.tenantId}`;
    c = await j(await call(app, "GET", "/usage/credits", t.token));
    expect(c).toMatchObject({ remainingMicro: 8 * MICRO, percentUsed: 84, status: "warning", warnings: ["warning_80"] });
    await owner`UPDATE tenant_credits SET used_micro = ${50 * MICRO}, topup_micro = ${3 * MICRO} WHERE tenant_id = ${t.tenantId}`;
    expect(await j(await call(app, "GET", "/usage/credits", t.token))).toMatchObject({ remainingMicro: 3 * MICRO, status: "warning" });
    await owner`UPDATE tenant_credits SET topup_micro = 0 WHERE tenant_id = ${t.tenantId}`;
    expect(await j(await call(app, "GET", "/usage/credits", t.token))).toMatchObject({ remainingMicro: 0, status: "exhausted", warnings: ["warning_80", "exhausted"] });
    // unlimited plan
    const ent = await newTenant("enterprise");
    expect(await j(await call(app, "GET", "/usage/credits", ent.token))).toMatchObject({ unlimited: true, allowanceMicro: null, remainingMicro: null, percentUsed: null, status: "ok" });
    // plan change applies immediately (pro = 4980 credits)
    await owner`UPDATE tenants SET plan_key = 'pro' WHERE id = ${t.tenantId}`;
    expect(await j(await call(app, "GET", "/usage/credits", t.token))).toMatchObject({ allowanceMicro: 4980 * MICRO, status: "ok" });
  });

  test("GET /usage/ai: grouping, totals, CSV, strict validation, tenant isolation", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const agentA = (await j(await call(app, "POST", "/agents", a.token, { name: "Sales bot" }))).id as string;
    const conv1 = crypto.randomUUID(), conv2 = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await event(a.tenantId, { agent: agentA, model: "gpt-x", conv: conv1, day: yesterday, p: 100, c: 50, credits: 1000 });
    await event(a.tenantId, { agent: agentA, model: "gpt-y", conv: conv1, p: 200, c: 100, credits: 5000 });
    await event(a.tenantId, { agent: null, model: "gpt-x", conv: conv2, p: 10, c: 5, credits: 100, source: "sandbox" });
    await event(b.tenantId, { model: "secret-model", p: 99999, c: 99999, credits: 999999999 });

    const byDay = await j(await call(app, "GET", "/usage/ai?groupBy=day", a.token));
    expect(byDay.items.map((i: any) => [i.key, i.totalTokens, i.requests, i.creditsMicro])).toEqual([[yesterday, 150, 1, 1000], [today, 315, 2, 5100]]);
    expect(byDay.totals).toEqual({ promptTokens: 310, completionTokens: 155, totalTokens: 465, requests: 3, creditsMicro: 6100 });
    const byAgent = await j(await call(app, "GET", `/usage/ai?groupBy=agent&from=${yesterday}&to=${today}`, a.token));
    expect(byAgent.items.map((i: any) => [i.key, i.label, i.creditsMicro])).toEqual([[agentA, "Sales bot", 6000], ["", "(unattributed)", 100]]);
    const byModel = await j(await call(app, "GET", "/usage/ai?groupBy=model", a.token));
    expect(byModel.items.map((i: any) => [i.key, i.creditsMicro])).toEqual([["gpt-y", 5000], ["gpt-x", 1100]]);
    const byConv = await j(await call(app, "GET", "/usage/ai?groupBy=conversation", a.token));
    expect(byConv.items.map((i: any) => [i.key, i.creditsMicro])).toEqual([[conv1, 6000], [conv2, 100]]);
    // range filter excludes yesterday
    expect((await j(await call(app, "GET", `/usage/ai?from=${today}&to=${today}`, a.token))).totals.creditsMicro).toBe(5100);
    // tenant B sees only its own, never A's
    const bAll = await j(await call(app, "GET", "/usage/ai?groupBy=model", b.token));
    expect(bAll.items.map((i: any) => i.key)).toEqual(["secret-model"]);
    expect(JSON.stringify(bAll)).not.toContain("gpt-");
    expect((await j(await call(app, "GET", "/usage/ai?groupBy=agent", b.token))).items.some((i: any) => i.key === agentA)).toBe(false);

    const csv = await call(app, "GET", `/usage/ai/export?groupBy=model`, a.token);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    expect((await csv.text()).split("\r\n").slice(0, 3)).toEqual(["key,label,promptTokens,completionTokens,totalTokens,requests,creditsMicro", "gpt-y,gpt-y,200,100,300,1,5000", "gpt-x,gpt-x,110,55,165,2,1100"]);

    for (const q of ["groupBy=hour", "from=2026-13-40", "from=2024-01-01&to=2026-01-01", "from=2026-02-01&to=2026-01-01", "extra=1", "to=yesterday"]) {
      expect([q, (await call(app, "GET", `/usage/ai?${q}`, a.token)).status]).toEqual([q, 400]);
    }
  });

  test("llm_tokens_monthly meter is live (was a dead counter)", async () => {
    const t = await newTenant();
    await event(t.tenantId, { p: 1000, c: 234 });
    const me = await j(await call(app, "GET", "/tenant", t.token));
    const m = me.limits.find((l: any) => l.metric === "llm_tokens_monthly");
    expect(m).toMatchObject({ limit: 200000, used: 1234 });
    const cr = me.limits.find((l: any) => l.metric === "llm_credits_monthly");
    expect(cr).toMatchObject({ limit: 50, used: 0 });
  });

  test("credit packs, checkout (Stripe payment mode), webhook top-up is idempotent and tenant-scoped", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const packs = await j(await call(app, "GET", "/billing/credit-packs", a.token));
    expect(packs.items.length).toBeGreaterThanOrEqual(3);
    expect(packs.items[0]).toMatchObject({ name: "Starter", credits: 500, priceCents: 900, currency: "usd" });
    expect(Object.keys(packs.items[0]).sort()).toEqual(["credits", "currency", "id", "name", "priceCents"]);

    expect((await call(app, "POST", "/billing/credits/checkout", a.token, { packId: crypto.randomUUID() })).status).toBe(404);
    expect((await call(app, "POST", "/billing/credits/checkout", a.token, { packId: packs.items[0].id, extra: 1 })).status).toBe(400);
    expect((await call(app, "POST", "/billing/credits/checkout", a.token, {})).status).toBe(400);
    stripeForms.length = 0;
    const co = await call(app, "POST", "/billing/credits/checkout", a.token, { packId: packs.items[0].id });
    expect(co.status).toBe(200);
    expect((await j(co)).url).toBe("https://stripe.test/credits");
    const form = stripeForms.find((f) => f.mode === "payment")!;
    expect(form).toMatchObject({
      mode: "payment", client_reference_id: a.tenantId, "metadata[kind]": "credit_topup", "metadata[packId]": packs.items[0].id, "metadata[credits]": "500",
      "metadata[tenantId]": a.tenantId, "line_items[0][price_data][unit_amount]": "900", "line_items[0][price_data][currency]": "usd",
    });
    expect(form.success_url).toContain("credits=success");

    // webhook: paid session credits the tenant exactly once
    const ev = topupEvent(a.tenantId, "cs_" + crypto.randomUUID(), 500);
    expect((await hook(ev)).status).toBe(200);
    expect(await j(await call(app, "GET", "/usage/credits", a.token))).toMatchObject({ topupMicro: 500 * MICRO, remainingMicro: 550 * MICRO });
    expect(await j(await hook(ev))).toMatchObject({ duplicate: true }); // same event redelivered
    const sameSession = topupEvent(a.tenantId, ev.data.object.id, 500, { type: "checkout.session.async_payment_succeeded" });
    expect(await j(await hook(sameSession))).toMatchObject({ duplicate: true }); // second event type for the same session
    expect((await j(await call(app, "GET", "/usage/credits", a.token))).topupMicro).toBe(500 * MICRO);
    // unpaid sessions, other kinds and malformed payloads credit nothing
    expect(await j(await hook(topupEvent(a.tenantId, "cs_u", 500, { paid: false })))).toMatchObject({ ignored: true });
    expect(await j(await hook(topupEvent(a.tenantId, "cs_k", 500, { kind: "other" })))).toMatchObject({ ignored: true });
    expect(await j(await hook(topupEvent(crypto.randomUUID(), "cs_unknown", 500)))).toMatchObject({ ignored: true });
    expect(await j(await hook(topupEvent("not-a-uuid", "cs_bad", 500)))).toMatchObject({ ignored: true });
    expect((await j(await call(app, "GET", "/usage/credits", a.token))).topupMicro).toBe(500 * MICRO);
    // tenant B untouched, audit row written for A
    expect((await j(await call(app, "GET", "/usage/credits", b.token))).topupMicro).toBe(0);
    const [aud] = await owner`SELECT metadata FROM audit_logs WHERE tenant_id = ${a.tenantId} AND action = 'billing.credits_purchased'`;
    expect(aud).toBeTruthy();
    expect((await owner`SELECT count(*)::int AS n FROM credit_topups WHERE tenant_id = ${a.tenantId}`)[0]!.n).toBe(1);
    // forged webhook (bad signature) is rejected
    const bad = signed(topupEvent(b.tenantId, "cs_forged", 9999));
    expect((await app.request("/api/v1/webhooks/billing", { method: "POST", body: bad.body, headers: { ...bad.headers, "stripe-signature": "t=1,v1=00" } })).status).toBe(400);
    expect((await j(await call(app, "GET", "/usage/credits", b.token))).topupMicro).toBe(0);
  });

  test("top-up lifts an exhausted tenant (sandbox 402 credits_exhausted, then 200)", async () => {
    const t = await newTenant();
    const agent = (await j(await call(app, "POST", "/agents", t.token, { name: "Bot" }))).id as string;
    await call(app, "GET", "/usage/credits", t.token);
    await owner`UPDATE tenant_credits SET used_micro = allowance_micro WHERE tenant_id = ${t.tenantId}`;
    const r = await call(app, "POST", "/knowledge/sandbox", t.token, { agentId: agent, message: "hello" });
    expect(r.status).toBe(402);
    expect(await j(r)).toMatchObject({ error: { code: "credits_exhausted", details: { remainingMicro: 0 } } });
    expect((await hook(topupEvent(t.tenantId, "cs_" + crypto.randomUUID(), 500))).status).toBe(200);
    const ok = await call(app, "POST", "/knowledge/sandbox", t.token, { agentId: agent, message: "hello" });
    expect(ok.status).toBe(200);
    const body = await j(ok);
    expect(body.modelNote).toBeNull();
    const [ev] = await owner<{ source: string }[]>`SELECT source FROM ai_usage_events WHERE tenant_id = ${t.tenantId}`;
    expect(ev!.source).toBe("sandbox");
  });

  test("self-hosted: credits disabled, usage still recorded and readable, no billing routes", async () => {
    const t = await shTenantToken();
    expect(await j(await call(sh, "GET", "/usage/credits", t.token))).toMatchObject({ mode: "selfhosted", enabled: false, unlimited: true, allowanceMicro: null, remainingMicro: null, status: "ok", warnings: [] });
    expect((await owner`SELECT count(*)::int AS n FROM tenant_credits WHERE tenant_id = ${t.tenantId}`)[0]!.n).toBe(0); // nothing created
    await event(t.tenantId, { credits: 777 });
    expect((await j(await call(sh, "GET", "/usage/ai", t.token))).totals).toMatchObject({ requests: 1, creditsMicro: 777 });
    expect((await call(sh, "GET", "/billing/credit-packs", t.token)).status).toBe(404);
    expect((await call(sh, "POST", "/billing/credits/checkout", t.token, { packId: crypto.randomUUID() })).status).toBe(404);
    // the sandbox is never gated
    const agent = (await j(await call(sh, "POST", "/agents", t.token, { name: "Bot" }))).id as string;
    expect((await call(sh, "POST", "/knowledge/sandbox", t.token, { agentId: agent, message: "hello" })).status).toBe(200);
  });

  test("RLS: the app role sees only its tenant's events/credits and cannot read provider credentials", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await event(a.tenantId); await event(b.tenantId);
    await call(app, "GET", "/usage/credits", a.token); await call(app, "GET", "/usage/credits", b.token);
    const { withTenant } = await import("@yulona/db");
    const seenEvents = await withTenant(db, a.tenantId, (tx) => tx<{ tenantId: string }[]>`SELECT DISTINCT tenant_id FROM ai_usage_events`);
    expect(seenEvents.map((r) => r.tenantId)).toEqual([a.tenantId]);
    const seenCredits = await withTenant(db, a.tenantId, (tx) => tx<{ tenantId: string }[]>`SELECT DISTINCT tenant_id FROM tenant_credits`);
    expect(seenCredits.map((r) => r.tenantId)).toEqual([a.tenantId]);
    await expect(withTenant(db, a.tenantId, (tx) => tx`SELECT * FROM llm_provider_profiles`)).rejects.toThrow();
    await expect(withTenant(db, a.tenantId, (tx) => tx`SELECT consume_credits(${b.tenantId}::uuid, 1000::bigint)`)).rejects.toThrow(); // RLS blocks poking another tenant
    await expect(withTenant(db, a.tenantId, (tx) => tx`INSERT INTO ai_usage_events (tenant_id, prompt_tokens) VALUES (${b.tenantId}, 1)`)).rejects.toThrow();
  });
});
