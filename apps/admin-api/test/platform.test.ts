import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, mkTenant, type AdminBoot, type TestAdmin } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("platform overview, analytics, health, usage", () => {
  let b: AdminBoot, a: TestAdmin;
  beforeAll(async () => { b = await bootAdmin(); a = await mkAdmin(b, "support"); });
  afterAll(async () => b.close());

  test("analytics and overview numbers follow the data", async () => {
    await mkTenant(b, "an", "pro");
    const an = await jsonOf(await call(b, "GET", "/analytics", a));
    expect(an.tenants.total).toBeGreaterThanOrEqual(1);
    expect(an.mrrCents).toBeGreaterThanOrEqual(4900);
    expect(an.funnel.map((f: { stage: string }) => f.stage)).toEqual(["visitor", "engaged", "qualified", "booking_offered", "booked", "handoff_requested"]);
    const o = await jsonOf(await call(b, "GET", "/overview", a));
    expect(o.tenants.new7d).toBeGreaterThanOrEqual(1);
    expect(o.byPlan.find((p: { plan: string }) => p.plan === "pro").count).toBeGreaterThanOrEqual(1);
    // credits consumed and the 30-day series
    const t = await mkTenant(b, "cr", "pro");
    await b.owner`INSERT INTO ai_usage_events (tenant_id, source, model, prompt_tokens, completion_tokens, credits_micro) VALUES (${t.tenantId}, 'turn', 'm', 1, 1, 123456)`;
    const o2 = await jsonOf(await call(b, "GET", "/overview", a));
    expect(o2.creditsConsumed30d - o.creditsConsumed30d).toBe(123456);
    expect(o2.series.credits.reduce((n: number, p: { value: number }) => n + p.value, 0)).toBeGreaterThanOrEqual(123456);
    expect(o2.series.signups.length).toBeGreaterThanOrEqual(1);
    // active7d counts customers with messages in the last 7 days
    const [ct] = await b.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${t.tenantId}) RETURNING id`;
    const [cv] = await b.owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id) VALUES (${t.tenantId}, ${ct!.id}) RETURNING id`;
    await b.owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${t.tenantId}, ${cv!.id}, 'contact', 'hi')`;
    const o3 = await jsonOf(await call(b, "GET", "/overview", a));
    expect(o3.active7d - o2.active7d).toBe(1);
  });

  test("platform health: db, queue and worker heartbeat", async () => {
    await b.owner`DELETE FROM worker_heartbeats`;
    await b.owner`DELETE FROM jobs WHERE status = 'dead'`;
    let h = await jsonOf(await call(b, "GET", "/health", a));
    expect(h).toMatchObject({ status: "degraded", db: { ok: true }, worker: { ok: false, lastHeartbeatAt: null } });
    await b.owner`SELECT worker_heartbeat('worker')`;
    h = await jsonOf(await call(b, "GET", "/health", a));
    expect(h.worker.ok).toBe(true);
    expect(h.status).toBe("ok");
    expect(h.queue).toMatchObject({ dead: 0 });
    const t = await mkTenant(b);
    await b.owner`INSERT INTO jobs (tenant_id, name, status, attempts, last_error) VALUES (${t.tenantId}, 'x', 'dead', 5, 'e')`;
    expect((await jsonOf(await call(b, "GET", "/health", a))).status).toBe("degraded"); // a dead job degrades the platform
  });

  test("tenant usage rollup feeds the admin usage chart; tenants are isolated", async () => {
    const t1 = await mkTenant(b, "u1", "enterprise"), t2 = await mkTenant(b, "u2", "enterprise");
    const [c] = await b.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${t1.tenantId}) RETURNING id`;
    const [cv] = await b.owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id) VALUES (${t1.tenantId}, ${c!.id}) RETURNING id`;
    await b.owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${t1.tenantId}, ${cv!.id}, 'contact', 'hi'), (${t1.tenantId}, ${cv!.id}, 'note', 'n')`;
    const today = new Date().toISOString().slice(0, 10);
    await b.owner`SELECT usage_rollup(${today}::date, ${today}::date)`;
    const u = await jsonOf(await call(b, "GET", `/tenants/${t1.tenantId}/usage?days=7`, a));
    const val = (m: string) => u.series.find((s: { metric: string; day: string }) => s.metric === m && s.day === today)?.value;
    expect([val("conversations"), val("messages"), val("new_contacts")]).toEqual([1, 1, 1]); // notes excluded
    expect(u.limits.find((l: { metric: string }) => l.metric === "seats")).toMatchObject({ limit: null, used: 1, warning: false });
    expect((await jsonOf(await call(b, "GET", `/tenants/${t2.tenantId}/usage`, a))).series).toHaveLength(0);
    expect((await call(b, "GET", `/tenants/${t1.tenantId}/usage?days=0`, a)).status).toBe(400);
  });

  test("plan limits report live usage with the warning flag", async () => {
    await b.owner`INSERT INTO plans (key, name) VALUES ('tiny_admin','Tiny admin') ON CONFLICT DO NOTHING`;
    await b.owner`INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES ('tiny_admin','widgets',2),('tiny_admin','seats',1) ON CONFLICT DO NOTHING`;
    const t = await mkTenant(b, "tiny_admin", "tiny_admin");
    await b.owner`INSERT INTO widgets (tenant_id, name, widget_key) VALUES (${t.tenantId}, 'w', ${`wk_${crypto.randomUUID().replace(/-/g, "")}`})`;
    const d = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}`, a));
    expect(d.limits.find((l: { metric: string }) => l.metric === "widgets")).toEqual({ metric: "widgets", limit: 2, used: 1, warning: false });
    expect(d.limits.find((l: { metric: string }) => l.metric === "seats")).toEqual({ metric: "seats", limit: 1, used: 1, warning: true });
    expect(d.limits.find((l: { metric: string }) => l.metric === "agents")).toMatchObject({ limit: null });
    expect(d.limits).toHaveLength(8);
  });
});
