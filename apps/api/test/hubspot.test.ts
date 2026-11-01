import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { withTenant } from "@yulona/db";
import { advanceTo, getOrCreateState, mergeLead } from "@yulona/ai-runtime";
import { buildHubSpotProperties, createHubSpotJobHandlers, HubSpotClient, openHubspotToken, parseHubspotMapping } from "@yulona/ops";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);
const KEY = Buffer.alloc(32, 5).toString("base64");
const GOOD = "pat-na1-good-token-0000";
type Tenant = { tenantId: string; userId: string; token: string; h: Record<string, string> };

describe.skipIf(!hasDb)("hubspot (fake HubSpot server)", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  let srv: ReturnType<typeof Bun.serve>;
  let A: Tenant, B: Tenant, AgentA: Tenant;
  const base = () => `http://localhost:${srv.port}`;
  const hs = {
    contacts: new Map<string, { id: string; properties: Record<string, string> }>(), nextId: 100, calls: [] as string[], throttle: 0, fail500: 0, race409: false, tokens: new Set<string>(),
    lastBody: null as any, searches: 0,
  };
  const retry = { attempts: 3, baseMs: 1, timeoutMs: 2000 };
  const handlers = () => createHubSpotJobHandlers({ db, encryptionKey: KEY, appUrl: "https://app.example.test", apiBase: base(), retry });

  async function mkTenant(label: string, role: "owner" | "agent" = "owner", tenantId?: string): Promise<Tenant> {
    let t: { tenantId: string; userId: string };
    if (tenantId) {
      const [u] = await owner<{ id: string }[]>`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tenantId}, ${`${label}-${crypto.randomUUID().slice(0, 6)}@example.test`}, ${label}, ${role}, 'x') RETURNING id`;
      t = { tenantId, userId: u!.id };
    } else t = await seedTenantWithUser(owner, label);
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { ...t, token, h: { authorization: `Bearer ${token}` } };
  }
  const call = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ok = async (method: string, path: string, h: Record<string, string>, body?: unknown, status = 200) => {
    const res = await call(method, path, h, body);
    if (res.status !== status) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json().catch(() => null)) as any;
  };

  /** A conversation with a lead; returns ids. */
  async function mkConversation(t: Tenant, lead: Record<string, unknown>, contact: { name?: string; email?: string } = {}) {
    const [c] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name, email) VALUES (${t.tenantId}, ${contact.name ?? null}, ${contact.email ?? null}) RETURNING id`;
    const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id) VALUES (${t.tenantId}, ${c!.id}) RETURNING id`;
    await withTenant(db, t.tenantId, async (tx) => { await getOrCreateState(tx, t.tenantId, cv!.id); await mergeLead(tx, t.tenantId, cv!.id, lead as never); });
    return { contactId: c!.id, conversationId: cv!.id };
  }
  const stage = (t: Tenant, conv: string, to: "engaged" | "qualified" | "booking_offered" | "booked") =>
    withTenant(db, t.tenantId, async (tx) => { await advanceTo(tx, t.tenantId, conv, (await getOrCreateState(tx, t.tenantId, conv)).stage, to, "test"); });
  const jobs = (t: Tenant) => owner<{ payload: any }[]>`SELECT payload FROM jobs WHERE tenant_id = ${t.tenantId} AND name = 'crm.hubspot.sync' ORDER BY created_at`;
  const run = (t: Tenant, conversationId: string, trigger: "qualified" | "booked") => handlers()["crm.hubspot.sync"]!({ conversationId, trigger }, { job: { tenantId: t.tenantId } });
  const log = (t: Tenant, conv: string) => owner<{ trigger: string; status: string; action: string | null; hubspotId: string | null; error: string | null; attempts: number }[]>`
    SELECT trigger, status, action, hubspot_id AS "hubspotId", error, attempts FROM crm_sync_log WHERE tenant_id = ${t.tenantId} AND conversation_id = ${conv} ORDER BY trigger`;

  beforeAll(async () => {
    srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const auth = req.headers.get("authorization") ?? "";
        hs.calls.push(`${req.method} ${u.pathname}`);
        if (!hs.tokens.has(auth.replace("Bearer ", ""))) return Response.json({ status: "error", message: "Authentication credentials not found.", category: "INVALID_AUTHENTICATION" }, { status: 401 });
        if (hs.throttle > 0) { hs.throttle--; return Response.json({ status: "error", message: "You have reached your secondly limit.", category: "RATE_LIMITS" }, { status: 429 }); }
        if (hs.fail500 > 0) { hs.fail500--; return new Response("boom", { status: 502 }); }
        if (u.pathname === "/crm/v3/objects/contacts" && req.method === "GET") return Response.json({ results: [] });
        if (u.pathname === "/crm/v3/objects/contacts/search") {
          hs.searches++;
          const b = (await req.json()) as any;
          const email = b.filterGroups[0].filters[0].value;
          if (hs.race409) return Response.json({ results: [], total: 0 });
          const hit = [...hs.contacts.values()].find((c) => c.properties.email === email);
          return Response.json({ total: hit ? 1 : 0, results: hit ? [{ id: hit.id, properties: hit.properties }] : [] });
        }
        if (u.pathname === "/crm/v3/objects/contacts" && req.method === "POST") {
          const b = (await req.json()) as any;
          hs.lastBody = b;
          const dup = [...hs.contacts.values()].find((c) => c.properties.email === b.properties.email);
          if (dup) { hs.race409 = false; return Response.json({ status: "error", message: `Contact already exists. Existing ID: ${dup.id}`, category: "CONFLICT" }, { status: 409 }); }
          const id = String(hs.nextId++);
          hs.contacts.set(id, { id, properties: b.properties });
          return Response.json({ id, properties: b.properties }, { status: 201 });
        }
        const m = /^\/crm\/v3\/objects\/contacts\/(\w+)$/.exec(u.pathname);
        if (m && req.method === "PATCH") {
          const b = (await req.json()) as any;
          hs.lastBody = b;
          const c = hs.contacts.get(m[1]!);
          if (!c) return Response.json({ message: "not found" }, { status: 404 });
          if ("lead_need_bad" in b.properties) return Response.json({ status: "error", message: "Property values were not valid", category: "VALIDATION_ERROR" }, { status: 400 });
          c.properties = { ...c.properties, ...b.properties };
          return Response.json({ id: c.id, properties: c.properties });
        }
        return new Response("nf", { status: 404 });
      },
    });
    hs.tokens.add(GOOD);
    const s = await setupTestDb();
    owner = s.owner; db = s.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({}, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; c.encryptionKey = KEY; c.appUrl = "https://app.example.test"; });
    app = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }), ops: { hubspot: { apiBase: base(), retry } } });
    A = await mkTenant("A"); B = await mkTenant("B"); AgentA = await mkTenant("agentA", "agent", A.tenantId);
  });
  afterAll(async () => { srv?.stop(true); limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  test("client: upsert creates then updates, 429 and 5xx retried, 409 race falls back to PATCH", async () => {
    const c = new HubSpotClient(GOOD, { apiBase: base(), retry });
    const r1 = await c.upsertContact({ email: "client@x.test", properties: { firstname: "Ann" } });
    expect(r1.action).toBe("created");
    hs.throttle = 2;
    const r2 = await c.upsertContact({ email: "client@x.test", properties: { firstname: "Anna", lifecyclestage: "lead" } });
    expect(r2).toEqual({ id: r1.id, action: "updated" });
    expect(hs.contacts.get(r1.id)!.properties).toMatchObject({ firstname: "Anna" });
    expect(hs.contacts.get(r1.id)!.properties.lifecyclestage).toBeUndefined(); // create-only
    hs.fail500 = 1;
    expect((await c.upsertContact({ email: "client@x.test", properties: {} })).action).toBe("updated");
    hs.race409 = true; // search misses the contact, POST answers 409 "Existing ID"
    expect(await c.upsertContact({ email: "client@x.test", properties: { firstname: "Race" } })).toEqual({ id: r1.id, action: "updated" });
    // persistent 429 exhausts retries and surfaces
    hs.throttle = 10;
    await expect(c.upsertContact({ email: "client@x.test", properties: {} })).rejects.toMatchObject({ status: 429 });
    hs.throttle = 0;
    // bad token: 401, not retried
    hs.calls.length = 0;
    await expect(new HubSpotClient("nope", { apiBase: base(), retry }).testConnection()).rejects.toMatchObject({ status: 401, authFailure: true });
    expect(hs.calls).toEqual(["GET /crm/v3/objects/contacts"]);
  });

  test("mapping builds only mapped properties", () => {
    const m = parseHubspotMapping({ properties: { need: "lead_need", source: "lead_source_text" }, lifecycleStage: "lead" });
    expect(buildHubSpotProperties({ name: "Ann Lee Smith", phone: "+1", need: "pricing", budget: "5k", score: 3 }, m, "https://a/b")).toEqual({
      firstname: "Ann", lastname: "Lee Smith", phone: "+1", lead_need: "pricing", lead_source_text: "Lumi chat", lifecyclestage: "lead",
    });
  });

  test("connect: bad token rejected, good token stored encrypted + write-only, roles, mapping, status", async () => {
    expect((await call("GET", "/crm/hubspot", AgentA.h)).status).toBe(403);
    expect((await call("PUT", "/crm/hubspot/connection", AgentA.h, { token: GOOD })).status).toBe(403);
    expect((await call("GET", "/crm/hubspot", {})).status).toBe(401);
    const bad = await call("PUT", "/crm/hubspot/connection", A.h, { token: "not-a-valid-token-123" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("not-a-valid-token-123");
    expect((await call("PUT", "/crm/hubspot/connection", A.h, { token: GOOD, extra: 1 })).status).toBe(400);
    expect((await ok("GET", "/crm/hubspot", A.h)).connected).toBe(false);

    await ok("PUT", "/crm/hubspot/connection", A.h, { token: GOOD, mapping: { properties: { need: "lead_need" } } });
    const st = await ok("GET", "/crm/hubspot", A.h);
    expect(st).toMatchObject({ configured: true, connected: true, status: "active", mapping: { properties: { need: "lead_need" }, sourceValue: "Lumi chat", syncOnBooked: true } });
    expect(JSON.stringify(st)).not.toContain(GOOD);
    const [row] = await owner`SELECT token_encrypted FROM crm_connections WHERE tenant_id = ${A.tenantId}`;
    expect(row!.token_encrypted).not.toContain(GOOD);
    expect(openHubspotToken(KEY, A.tenantId, row!.token_encrypted)).toBe(GOOD);
    expect(() => openHubspotToken(KEY, B.tenantId, row!.token_encrypted)).toThrow(); // AAD bound to the tenant

    expect((await call("PATCH", "/crm/hubspot/mapping", A.h, { mapping: { properties: { need: "Bad Name" } } })).status).toBe(400);
    await ok("PATCH", "/crm/hubspot/mapping", A.h, { mapping: { properties: { need: "lead_need", budget: "lead_budget" }, syncOnBooked: true } });
    expect((await ok("GET", "/crm/hubspot", A.h)).mapping.properties.budget).toBe("lead_budget");
    const audits = await owner`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND resource_type = 'crm' ORDER BY created_at`;
    expect(audits.map((a) => a.action)).toEqual(["crm.connect", "crm.update"]);
  });

  test("test contact: creates then updates; cross-tenant isolation on every route", async () => {
    const r1 = await ok("POST", "/crm/hubspot/test-contact", A.h, { email: "Test@Example.test", name: "Tess Ter" });
    expect(r1.action).toBe("created");
    expect(hs.lastBody.properties).toMatchObject({ email: "test@example.test", firstname: "Tess", lastname: "Ter", lead_need: "Test contact from Lumi" });
    expect((await ok("POST", "/crm/hubspot/test-contact", A.h, { email: "test@example.test" })).action).toBe("updated");
    expect((await call("POST", "/crm/hubspot/test-contact", AgentA.h, { email: "t@x.test" })).status).toBe(403);
    // tenant B has nothing: sees no connection, cannot test/patch/delete A's
    expect(await ok("GET", "/crm/hubspot", B.h)).toMatchObject({ connected: false, recent: [] });
    expect((await call("POST", "/crm/hubspot/test-contact", B.h, { email: "t@x.test" })).status).toBe(404);
    expect((await call("PATCH", "/crm/hubspot/mapping", B.h, { mapping: {} })).status).toBe(404);
    expect((await call("DELETE", "/crm/hubspot/connection", B.h)).status).toBe(404);
    expect((await ok("GET", "/crm/hubspot", A.h)).connected).toBe(true);
    expect((await ok("GET", "/crm/hubspot", A.h)).recent.length).toBe(2);
  });

  test("qualified enqueues once and emits lead.qualified; the job creates, then booked updates; token never logged", async () => {
    const hook = await ok("POST", "/webhooks", A.h, { name: "h", url: "https://hooks.example.test/in", events: ["lead.qualified"] }, 201);
    const { conversationId, contactId } = await mkConversation(A, { name: "Bea Cole", email: "bea@x.test", need: "demo", budget: "10k" });
    await stage(A, conversationId, "engaged");
    expect((await jobs(A)).length).toBe(0);
    await stage(A, conversationId, "qualified");
    const q = await jobs(A);
    expect(q.map((j) => j.payload)).toEqual([{ conversationId, trigger: "qualified" }]);
    const dv = await owner`SELECT payload FROM webhook_deliveries WHERE tenant_id = ${A.tenantId} AND webhook_id = ${hook.id} AND event_type = 'lead.qualified'`;
    expect(dv.length).toBe(1);
    expect(dv[0]!.payload.data).toMatchObject({ conversationId, contactId, lead: { email: "bea@x.test", need: "demo" } });

    await run(A, conversationId, "qualified");
    expect(hs.lastBody.properties).toMatchObject({ email: "bea@x.test", firstname: "Bea", lastname: "Cole", lead_need: "demo", lead_budget: "10k" });
    let rows = await log(A, conversationId);
    expect(rows).toMatchObject([{ trigger: "qualified", status: "ok", action: "created" }]);
    const hid = rows[0]!.hubspotId!;
    const [ct] = await owner`SELECT hubspot_id AS "hubspotId" FROM contacts WHERE id = ${contactId}`;
    expect(ct!.hubspotId).toBe(hid);
    // idempotent: re-running the same job makes no HubSpot call
    hs.calls.length = 0;
    await run(A, conversationId, "qualified");
    expect(hs.calls).toEqual([]);

    await stage(A, conversationId, "booking_offered");
    await stage(A, conversationId, "booked");
    expect((await jobs(A)).length).toBe(2);
    await run(A, conversationId, "booked");
    rows = await log(A, conversationId);
    expect(rows.map((r) => [r.trigger, r.status, r.action, r.hubspotId])).toEqual([["booked", "ok", "updated", hid], ["qualified", "ok", "created", hid]]);
    const [conn] = await owner`SELECT last_error AS "lastError", last_sync_at AS "lastSyncAt", status FROM crm_connections WHERE tenant_id = ${A.tenantId}`;
    expect(conn).toMatchObject({ lastError: null, status: "active" });
    expect(conn!.lastSyncAt).not.toBeNull();
    // nothing for tenant B (cross-tenant): no log rows, no jobs
    expect((await jobs(B)).length).toBe(0);
    expect((await owner`SELECT 1 FROM crm_sync_log WHERE tenant_id = ${B.tenantId}`).length).toBe(0);
  });

  test("failures: transient errors are recorded and retried via the queue; no email skips; bad token marks the connection", async () => {
    // lead without any email: skipped, no HubSpot call
    const noMail = await mkConversation(A, { name: "No Mail" });
    await stage(A, noMail.conversationId, "qualified");
    hs.calls.length = 0;
    await run(A, noMail.conversationId, "qualified");
    expect(hs.calls).toEqual([]);
    expect(await log(A, noMail.conversationId)).toMatchObject([{ status: "skipped", error: "No email address captured for this lead" }]);

    // transient: HubSpot keeps failing -> job throws (queue retries), last_error recorded; next attempt succeeds
    const c2 = await mkConversation(A, { email: "retry@x.test", name: "Rita" });
    await stage(A, c2.conversationId, "qualified");
    hs.fail500 = 20;
    await expect(run(A, c2.conversationId, "qualified")).rejects.toThrow(/HubSpot HTTP 502/);
    expect(await log(A, c2.conversationId)).toMatchObject([{ status: "failed", attempts: 1 }]);
    expect((await ok("GET", "/crm/hubspot", A.h)).lastError).toContain("HubSpot HTTP 502");
    hs.fail500 = 0;
    await run(A, c2.conversationId, "qualified");
    expect(await log(A, c2.conversationId)).toMatchObject([{ status: "ok", action: "created", attempts: 2 }]);
    expect((await ok("GET", "/crm/hubspot", A.h)).lastError).toBeNull();

    // revoked token: permanent, no throw (no pointless retries), connection flagged for reconnect, token not leaked
    hs.tokens.delete(GOOD);
    const c3 = await mkConversation(A, { email: "revoked@x.test" });
    await stage(A, c3.conversationId, "qualified");
    await run(A, c3.conversationId, "qualified");
    const st = await ok("GET", "/crm/hubspot", A.h);
    expect(st).toMatchObject({ status: "error" });
    expect(st.lastError).toContain("Reconnect HubSpot");
    expect(JSON.stringify(st)).not.toContain(GOOD);
    expect((await log(A, c3.conversationId))[0]).toMatchObject({ status: "failed" });
    const t = await call("POST", "/crm/hubspot/test-contact", A.h, { email: "again@x.test" });
    expect(t.status).toBe(502);
    expect(await t.text()).not.toContain(GOOD);
    hs.tokens.add(GOOD);
    // reconnect clears the error
    await ok("PUT", "/crm/hubspot/connection", A.h, { token: GOOD });
    expect(await ok("GET", "/crm/hubspot", A.h)).toMatchObject({ status: "active", lastError: null });
  });

  test("without a connection nothing is enqueued, but lead.qualified still fires; disconnect wipes the token", async () => {
    const { conversationId } = await mkConversation(B, { email: "b@x.test" });
    await stage(B, conversationId, "qualified");
    expect((await jobs(B)).length).toBe(0);
    await ok("DELETE", "/crm/hubspot/connection", A.h);
    expect((await owner`SELECT 1 FROM crm_connections WHERE tenant_id = ${A.tenantId}`).length).toBe(0);
    expect((await ok("GET", "/crm/hubspot", A.h)).connected).toBe(false);
    const audits = await owner`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action = 'crm.disconnect'`;
    expect(audits.length).toBe(1);
  });
});
