import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { AUTO_DISABLE_AFTER, createIntegrationJobHandlers, openSecret, runRetention, verifyWebhookSignature } from "@yulona/integrations";
import { createMockProviders } from "@yulona/providers";
import { startWorker } from "@yulona/queue";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { buildOpenApi } from "../src/openapi";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const ENC_KEY = Buffer.alloc(32, 9).toString("base64");
const HOST = "https://hooks.example.test";


describe.skipIf(!hasDb)("integrations", () => {
  type Tenant = { tenantId: string; userId: string; token: string; h: Record<string, string> };
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  const providers = createMockProviders();
  let presign = true; // false => the storage backend cannot presign and the API streams the file
  const memorySignedUrl = providers.storage.signedUrl.bind(providers.storage);
  providers.storage.signedUrl = async (k, o) => (presign ? memorySignedUrl(k, o) : null);
  let A: Tenant, B: Tenant;

  // ---- webhook receiver (stand-in for the customer's endpoint); real fetch goes to this server
  interface Hit { headers: Headers; body: string }
  const hits: Hit[] = [];
  let respond: (n: number) => number = () => 200;
  let receiver: ReturnType<typeof Bun.serve>;
  let publicIp = "93.184.216.34";
  const fetchImpl = ((u: URL | string, init?: RequestInit) =>
    fetch(String(u).replace(HOST, `http://127.0.0.1:${receiver.port}`), init)) as typeof fetch;
  const resolver = async () => [publicIp];
  const handlers = () => createIntegrationJobHandlers({
    storage: providers.storage, deliver: { fetchImpl, resolver, encryptionKey: () => ENC_KEY, timeoutMs: 3000 },
  });
  /** Run queued jobs owned by this area until none are due; returns how many ran. */
  async function drain() {
    const h = handlers();
    const names = Object.keys(h);
    const succeeded = async () => (await owner`SELECT count(*)::int AS n FROM jobs WHERE name = ANY(${names}) AND status = 'succeeded'`)[0]!.n as number;
    const before = await succeeded();
    const w = startWorker(db, h, { pollIntervalMs: 20 });
    for (let i = 0; i < 400; i++) {
      await w.tick();
      const [r] = await owner`SELECT count(*)::int AS n FROM jobs WHERE name = ANY(${names}) AND ((status = 'queued' AND run_at <= now()) OR status = 'running')`;
      if (r!.n === 0) break;
      await Bun.sleep(10);
    }
    await w.stop();
    return (await succeeded()) - before;
  }

  async function mkTenant(label: string, role: "owner" | "admin" | "agent" = "owner"): Promise<Tenant> {
    const t = await seedTenantWithUser(owner, label);
    await owner`UPDATE tenants SET plan_key = 'enterprise' WHERE id = ${t.tenantId}`;
    if (role !== "owner") await owner`UPDATE users SET role = ${role} WHERE id = ${t.userId}`;
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { ...t, token, h: { authorization: `Bearer ${token}` } };
  }
  const addUser = async (t: Tenant, role: "admin" | "agent") => {
    const [u] = await owner<{ id: string }[]>`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t.tenantId}, ${`m-${crypto.randomUUID().slice(0, 8)}@example.test`}, 'm', ${role}, 'x') RETURNING id`;
    const token = await signAccessToken(SECRET, { userId: u!.id, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { userId: u!.id, h: { authorization: `Bearer ${token}` } };
  };
  const api = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = async <T = Record<string, any>>(r: Response) => (await r.json()) as T;

  async function mkKey(t: Tenant, scopes: string[], rateLimitPerMinute = 600) {
    const r = await api("POST", "/api-keys", t.h, { name: "k", scopes, rateLimitPerMinute });
    expect(r.status).toBe(201);
    const k = await j<{ key: string }>(r);
    return { authorization: `Bearer ${k.key}` };
  }
  const pub = (method: string, path: string, h: Record<string, string>, body?: unknown) => api(method, `/public-api${path}`, h, body);
  async function mkHook(t: Tenant, events: string[] = ["*"], url = `${HOST}/in`) {
    const r = await api("POST", "/webhooks", t.h, { name: "hook", url, events });
    expect(r.status).toBe(201);
    return j<{ id: string; secret: string }>(r);
  }
  const deliveries = (tenantId: string, hookId: string) =>
    owner<{ id: string; status: string; eventType: string; attempts: number; responseStatus: number | null; lastError: string | null; nextAttemptAt: Date | null }[]>`
      SELECT id, status, event_type AS "eventType", attempts, response_status AS "responseStatus", last_error AS "lastError", next_attempt_at AS "nextAttemptAt" FROM webhook_deliveries
      WHERE tenant_id = ${tenantId} AND webhook_id = ${hookId} ORDER BY created_at, id`;

  beforeAll(async () => {
    const s = await setupTestDb();
    owner = s.owner; db = s.app;
    // this DB is reused between runs: retire jobs left over from earlier runs so they cannot reach the receiver
    await owner`UPDATE jobs SET status = 'dead' WHERE status IN ('queued','running') AND name IN ('webhook.deliver','gdpr.export','gdpr.erase')`;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({ ENCRYPTION_KEY: ENC_KEY }, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; });
    app = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }), providers });
    A = await mkTenant("intA");
    B = await mkTenant("intB");
    receiver = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: async (req) => {
        hits.push({ headers: req.headers, body: await req.text() });
        const code = respond(hits.length);
        return code >= 300 && code < 400 ? new Response(null, { status: code, headers: { location: "http://169.254.169.254/latest" } }) : new Response("ok-body", { status: code });
      },
    });
  });
  afterAll(async () => {
    receiver?.stop(true);
    limiter.close();
    await db.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });
  beforeEach(() => { hits.length = 0; respond = () => 200; publicIp = "93.184.216.34"; });

  // ------------------------------------------------------------------ webhook management
  test("auth + roles, validation, secret shown once and sealed at rest", async () => {
    expect((await api("GET", "/webhooks", {})).status).toBe(401);
    const agent = await addUser(A, "agent");
    expect((await api("GET", "/webhooks", agent.h)).status).toBe(403);
    expect((await api("POST", "/webhooks", agent.h, { name: "x", url: `${HOST}/x`, events: ["*"] })).status).toBe(403);
    for (const bad of [
      { name: "x", url: "http://127.0.0.1/x", events: ["*"] },
      { name: "x", url: "https://169.254.169.254/x", events: ["*"] },
      { name: "x", url: `${HOST}/x`, events: ["nope.event"] },
      { name: "x", url: `${HOST}/x`, events: [] },
      { name: "x", url: `${HOST}/x`, events: ["*"], tenantId: B.tenantId },
    ]) expect([bad, (await api("POST", "/webhooks", A.h, bad)).status]).toEqual([bad, 400]);

    const res = await api("POST", "/webhooks", A.h, { name: "main", url: `${HOST}/in`, events: ["message.created", "message.created", "contact.updated"] });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const hook = await j<{ id: string; secret: string; events: string[]; enabled: boolean }>(res);
    expect(hook.secret).toMatch(/^whsec_/);
    expect(hook.events).toEqual(["message.created", "contact.updated"]); // de-duplicated
    const [row] = await owner`SELECT secret_encrypted FROM webhooks WHERE id = ${hook.id}`;
    expect(row!.secret_encrypted).not.toContain(hook.secret);
    expect(openSecret(ENC_KEY, row!.secret_encrypted, hook.id)).toBe(hook.secret);
    const got = await j(await api("GET", `/webhooks/${hook.id}`, A.h));
    expect(JSON.stringify(got)).not.toContain("whsec_");
    expect(JSON.stringify(await j(await api("GET", "/webhooks", A.h)))).not.toContain("whsec_");

    const rot = await j<{ secret: string }>(await api("POST", `/webhooks/${hook.id}/rotate-secret`, A.h, {}));
    expect(rot.secret).not.toBe(hook.secret);
    const patched = await j(await api("PATCH", `/webhooks/${hook.id}`, A.h, { enabled: false, name: "renamed" }));
    expect(patched).toMatchObject({ enabled: false, name: "renamed", disabledReason: "Disabled manually" });
    expect((await api("PATCH", `/webhooks/${hook.id}`, A.h, {})).status).toBe(400);
    expect((await api("PATCH", `/webhooks/${hook.id}`, A.h, { url: "https://10.0.0.1/x" })).status).toBe(400);
    expect((await j<{ events: string[] }>(await api("GET", "/webhooks/events", A.h))).events).toContain("handoff.requested");
    const actions = (await owner`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND resource_id = ${hook.id}`).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["webhook.created", "webhook.secret_rotated", "webhook.updated"]));
    expect((await api("DELETE", `/webhooks/${hook.id}`, A.h)).status).toBe(200);
    expect((await api("GET", `/webhooks/${hook.id}`, A.h)).status).toBe(404);
  });

  test("cross-tenant: another tenant sees and touches nothing", async () => {
    const hook = await mkHook(A);
    expect((await api("POST", `/webhooks/${hook.id}/test`, A.h, {})).status).toBe(202);
    const [d] = await owner<{ id: string }[]>`SELECT id FROM webhook_deliveries WHERE webhook_id = ${hook.id}`;
    for (const [m, p, b] of [["GET", `/webhooks/${hook.id}`], ["PATCH", `/webhooks/${hook.id}`, { name: "x" }], ["DELETE", `/webhooks/${hook.id}`],
      ["POST", `/webhooks/${hook.id}/rotate-secret`, {}], ["POST", `/webhooks/${hook.id}/test`, {}], ["GET", `/webhooks/${hook.id}/deliveries`],
      ["GET", `/webhook-deliveries/${d!.id}`], ["POST", `/webhook-deliveries/${d!.id}/redeliver`, {}]] as const) {
      expect([m, p, (await api(m, p, B.h, b)).status]).toEqual([m, p, 404]);
    }
    expect((await j<{ items: unknown[] }>(await api("GET", "/webhooks", B.h))).items).toEqual([]);
    expect((await api("GET", "/webhooks/not-a-uuid", A.h)).status).toBe(404);
    await drain(); // flush the test delivery so it cannot leak into later tests
  });

  // ------------------------------------------------------------------ events + delivery
  test("events fan out from DB triggers, are signed, delivered and logged; notes stay private", async () => {
    const T = await mkTenant("fan");
    const hook = await mkHook(T, ["conversation.created", "message.created", "contact.created", "contact.updated", "handoff.requested"]);
    const other = await mkHook(T, ["ticket.created"]); // not subscribed to any event below
    const key = await mkKey(T, ["contacts:read", "contacts:write", "conversations:read", "conversations:write"]);

    const contact = await j<{ id: string }>(await pub("POST", "/contacts", key, { name: "Ada", email: "ada@example.test" }));
    const conv = await j<{ id: string }>(await pub("POST", "/conversations", key, { contactId: contact.id }));
    expect((await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "Hello from agent" })).status).toBe(201);
    expect((await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "internal only", sender: "note" })).status).toBe(201);
    expect((await pub("PATCH", `/contacts/${contact.id}`, key, { phone: "+251911000000" })).status).toBe(200);
    await owner`INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary) VALUES (${T.tenantId}, ${conv.id}, 'uncertainty', 'low confidence', 'needs a person')`;

    const queued = await deliveries(T.tenantId, hook.id);
    expect(queued.map((d) => d.eventType)).toEqual(["contact.created", "conversation.created", "message.created", "contact.updated", "handoff.requested"]);
    expect((await deliveries(T.tenantId, other.id)).length).toBe(0);
    expect(queued.every((d) => d.status === "pending")).toBe(true);

    await drain();
    const done = await deliveries(T.tenantId, hook.id);
    expect(done.every((d) => d.status === "succeeded" && d.attempts === 1 && d.responseStatus === 200)).toBe(true);
    expect(hits.map((h) => JSON.parse(h.body).type).sort()).toEqual(done.map((d) => d.eventType).sort());
    expect(hits.length).toBe(5);

    for (const h of hits) {
      const ts = h.headers.get("x-yulona-timestamp")!;
      expect(verifyWebhookSignature(hook.secret, h.body, { timestamp: ts, signature: h.headers.get("x-yulona-signature")! })).toBe(true);
      expect(verifyWebhookSignature("whsec_wrong", h.body, { timestamp: ts, signature: h.headers.get("x-yulona-signature")! })).toBe(false);
      const env = JSON.parse(h.body) as { id: string; type: string; tenantId: string; data: Record<string, any> };
      expect(env.tenantId).toBe(T.tenantId);
      expect(h.headers.get("x-yulona-event")).toBe(env.type);
      expect(h.headers.get("content-type")).toBe("application/json");
      expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const msg = hits.map((h) => JSON.parse(h.body)).find((e) => e.type === "message.created");
    expect(msg.data.message).toMatchObject({ conversationId: conv.id, senderType: "human", content: "Hello from agent" });
    expect(hits.some((h) => h.body.includes("internal only"))).toBe(false);
    const attempts = await owner`SELECT count(*)::int AS n FROM webhook_delivery_attempts WHERE tenant_id = ${T.tenantId} AND delivery_id = ANY(${done.map((d) => d.id)}::uuid[])`;
    expect(attempts[0]!.n).toBe(5);

    // detail endpoint exposes payload + attempt log; list paginates
    const detail = await j(await api("GET", `/webhook-deliveries/${done[0]!.id}`, T.h));
    expect(detail.payload.type).toBe("contact.created");
    expect(detail.attemptLog).toHaveLength(1);
    const p1 = await j<{ items: { id: string }[]; nextCursor: string | null }>(await api("GET", `/webhooks/${hook.id}/deliveries?limit=2`, T.h));
    expect(p1.items).toHaveLength(2);
    const p2 = await j<{ items: { id: string }[]; nextCursor: string | null }>(await api("GET", `/webhooks/${hook.id}/deliveries?limit=10&cursor=${p1.nextCursor}`, T.h));
    expect(p2.items).toHaveLength(3);
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(5);
    expect((await j<{ items: unknown[] }>(await api("GET", `/webhooks/${hook.id}/deliveries?status=failed`, T.h))).items).toEqual([]);

    // the other tenant's webhooks never see tenant A events
    const bHook = await mkHook(B);
    expect((await deliveries(B.tenantId, bHook.id)).length).toBe(0);
  });

  test("failed attempts retry later with backoff via the queue, then succeed; redelivery clones the event", async () => {
    const T = await mkTenant("retry");
    const hook = await mkHook(T, ["contact.created"]);
    const key = await mkKey(T, ["contacts:write"]);
    respond = (n) => (n === 1 ? 500 : 200);
    await pub("POST", "/contacts", key, { name: "Retry" });
    expect(await drain()).toBe(1);
    let [d] = await deliveries(T.tenantId, hook.id);
    expect(d).toMatchObject({ status: "retrying", attempts: 1, responseStatus: 500, lastError: "HTTP 500" });
    expect(d!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000); // first backoff is 30 s
    expect(await drain()).toBe(0); // not due yet
    const [job] = await owner`SELECT run_at FROM jobs WHERE tenant_id = ${T.tenantId} AND name = 'webhook.deliver' AND status = 'queued' AND payload->>'deliveryId' = ${d!.id}`;
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);

    await owner`UPDATE jobs SET run_at = now() WHERE tenant_id = ${T.tenantId} AND name = 'webhook.deliver' AND status = 'queued'`;
    expect(await drain()).toBe(1);
    [d] = await deliveries(T.tenantId, hook.id);
    expect(d).toMatchObject({ status: "succeeded", attempts: 2, responseStatus: 200 });
    expect(hits).toHaveLength(2);
    expect(JSON.parse(hits[0]!.body).id).toBe(JSON.parse(hits[1]!.body).id); // same event id: receivers can de-duplicate
    const log = await j(await api("GET", `/webhook-deliveries/${d!.id}`, T.h));
    expect(log.attemptLog.map((a: { statusCode: number }) => a.statusCode)).toEqual([500, 200]);

    const re = await api("POST", `/webhook-deliveries/${d!.id}/redeliver`, T.h, {});
    expect(re.status).toBe(202);
    await drain();
    const all = await deliveries(T.tenantId, hook.id);
    expect(all).toHaveLength(2);
    expect(all[1]!.status).toBe("succeeded");
    expect(JSON.parse(hits[2]!.body).id).toBe(JSON.parse(hits[0]!.body).id);
    const test = await j<{ deliveryId: string }>(await api("POST", `/webhooks/${hook.id}/test`, T.h, {}));
    await drain();
    expect(JSON.parse(hits[3]!.body).type).toBe("webhook.test");
    expect((await j(await api("GET", `/webhook-deliveries/${test.deliveryId}`, T.h))).status).toBe("succeeded");
  });

  test("exhausted attempts mark the delivery failed; repeated failures auto-disable the webhook; redeliver needs it enabled", async () => {
    const T = await mkTenant("exh");
    const hook = await mkHook(T, ["contact.created"]);
    const key = await mkKey(T, ["contacts:write"]);
    respond = () => 503;
    // one delivery with 1 attempt allowed, repeated until the failure counter trips the auto-disable
    for (let i = 0; i < AUTO_DISABLE_AFTER; i++) {
      await pub("POST", "/contacts", key, { name: `F${i}` });
      await owner`UPDATE webhook_deliveries SET max_attempts = 1 WHERE tenant_id = ${T.tenantId} AND webhook_id = ${hook.id} AND status = 'pending'`;
      await drain();
    }
    const all = await deliveries(T.tenantId, hook.id);
    expect(all.every((d) => d.status === "failed")).toBe(true);
    const w = await j(await api("GET", `/webhooks/${hook.id}`, T.h));
    expect(w).toMatchObject({ enabled: false, consecutiveFailures: AUTO_DISABLE_AFTER });
    expect(w.disabledReason).toContain("consecutive");
    const before = hits.length;
    await pub("POST", "/contacts", key, { name: "after disable" });
    expect(await drain()).toBe(0);
    expect(hits.length).toBe(before); // disabled webhooks get no new deliveries
    expect((await api("POST", `/webhook-deliveries/${all[0]!.id}/redeliver`, T.h, {})).status).toBe(409);
    await api("PATCH", `/webhooks/${hook.id}`, T.h, { enabled: true });
    expect(await j(await api("GET", `/webhooks/${hook.id}`, T.h))).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null });
  });

  test("SSRF: private resolution is refused (no request sent); redirects are never followed; 410 disables", async () => {
    const T = await mkTenant("ssrf");
    const hook = await mkHook(T, ["contact.created"]);
    const key = await mkKey(T, ["contacts:write"]);
    publicIp = "10.0.0.5"; // DNS rebinding style: a public-looking name resolving to a private address
    await pub("POST", "/contacts", key, { name: "ssrf" });
    await drain();
    let [d] = await deliveries(T.tenantId, hook.id);
    expect(d).toMatchObject({ status: "failed", attempts: 1 });
    expect(d!.lastError).toContain("non-public");
    expect(hits).toHaveLength(0);

    publicIp = "93.184.216.34";
    respond = () => 302;
    await pub("POST", "/contacts", key, { name: "redirect" });
    await drain();
    const rows = await deliveries(T.tenantId, hook.id);
    d = rows[1]!;
    expect(d).toMatchObject({ status: "retrying", responseStatus: 302 });
    expect(hits).toHaveLength(1); // the Location header (metadata service) was not followed

    respond = () => 410;
    await owner`UPDATE jobs SET run_at = now() WHERE tenant_id = ${T.tenantId} AND name = 'webhook.deliver' AND status = 'queued'`;
    await drain();
    const w = await j(await api("GET", `/webhooks/${hook.id}`, T.h));
    expect(w).toMatchObject({ enabled: false, disabledReason: "Endpoint returned 410 Gone" });
  });

  test("row-based events for ops tables (booking.created) are emitted as camelCased JSON", async () => {
    const T = await mkTenant("rowev");
    const hook = await mkHook(T, ["booking.created", "ticket.created", "ticket.updated"]);
    const trig = await owner`SELECT tgname FROM pg_trigger WHERE tgname IN ('webhooks_booking_insert','webhooks_ticket_insert','webhooks_ticket_update')`;
    expect(trig.map((t) => t.tgname).sort()).toEqual(["webhooks_booking_insert", "webhooks_ticket_insert", "webhooks_ticket_update"]);
    await owner`INSERT INTO bookings (tenant_id, title, start_at, end_at) VALUES (${T.tenantId}, 'Intro call', now() + interval '1 day', now() + interval '1 day 30 minutes')`;
    await drain();
    expect(hits).toHaveLength(1);
    const env = JSON.parse(hits[0]!.body);
    expect(env.type).toBe("booking.created");
    expect(env.data.booking).toMatchObject({ title: "Intro call", status: "booked", tenantId: T.tenantId });
    expect(Object.keys(env.data.booking)).toEqual(expect.arrayContaining(["startAt", "endAt", "createdAt"]));
    expect((await deliveries(T.tenantId, hook.id)).length).toBe(1);
  });

  // ------------------------------------------------------------------ public API
  test("public API: key auth, scopes, JWT rejected, revoked keys, strict bodies", async () => {
    expect((await pub("GET", "/contacts", {})).status).toBe(401);
    expect((await pub("GET", "/contacts", { authorization: "Bearer yl_deadbeef_" + "x".repeat(30) })).status).toBe(401);
    expect((await pub("GET", "/contacts", A.h)).status).toBe(401); // dashboard JWTs are not API keys
    const ro = await mkKey(A, ["contacts:read"]);
    expect((await pub("GET", "/contacts", ro)).status).toBe(200);
    expect((await pub("POST", "/contacts", ro, { name: "x" })).status).toBe(403);
    expect((await pub("GET", "/conversations", ro)).status).toBe(403);
    expect((await pub("GET", "/bookings", ro)).status).toBe(403);
    const rw = await mkKey(A, ["contacts:read", "contacts:write"]);
    expect((await pub("POST", "/contacts", rw, { name: "x", tenantId: B.tenantId })).status).toBe(400);
    expect((await pub("POST", "/contacts", rw, { email: "not-an-email" })).status).toBe(400);
    expect((await pub("GET", "/contacts?bogus=1", rw)).status).toBe(400);

    const k = await j<{ id: string; key: string }>(await api("POST", "/api-keys", A.h, { name: "tmp", scopes: ["contacts:read"] }));
    const h = { authorization: `Bearer ${k.key}` };
    expect((await pub("GET", "/contacts", h)).status).toBe(200);
    await api("DELETE", `/api-keys/${k.id}`, A.h);
    expect((await pub("GET", "/contacts", h)).status).toBe(401);
  });

  test("public API: per-key rate limit", async () => {
    const key = await mkKey(A, ["contacts:read"], 3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await pub("GET", "/contacts", key)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await pub("GET", "/contacts", key);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await pub("GET", "/contacts", await mkKey(A, ["contacts:read"], 3))).status).toBe(200); // other key unaffected
  });

  test("public API: contacts, conversations, messages, bookings; tenant-isolated", async () => {
    const key = await mkKey(A, ["contacts:read", "contacts:write", "conversations:read", "conversations:write", "bookings:read"]);
    const keyB = await mkKey(B, ["contacts:read", "contacts:write", "conversations:read", "conversations:write", "bookings:read"]);
    const c1 = await j<{ id: string; customAttributes: Record<string, unknown> }>(await pub("POST", "/contacts", key, { name: "Grace", email: "grace@example.test", customAttributes: { plan: "pro", drop: null } }));
    expect(c1.customAttributes).toEqual({ plan: "pro" });
    const upd = await j(await pub("PATCH", `/contacts/${c1.id}`, key, { customAttributes: { tier: "gold", plan: null } }));
    expect(upd.customAttributes).toEqual({ tier: "gold" });
    await pub("POST", "/contacts", key, { name: "Second contact" });
    const list = await j<{ items: { id: string }[]; nextCursor: string | null }>(await pub("GET", "/contacts?limit=1", key));
    expect(list.items).toHaveLength(1);
    expect(list.nextCursor).toBeTruthy();
    expect((await j<{ items: { id: string }[] }>(await pub("GET", "/contacts?q=grace", key))).items.map((x) => x.id)).toContain(c1.id);

    const conv = await j<{ id: string; status: string; handler: string; channel: string }>(await pub("POST", "/conversations", key, { contactId: c1.id, metadata: { ref: "crm-1" } }));
    expect(conv).toMatchObject({ status: "open", handler: "ai", channel: "widget" });
    expect((await pub("POST", "/conversations", key, { contactId: crypto.randomUUID() })).status).toBe(404);

    // agent message is idempotent by clientMessageId; contact message queues the AI reply
    const m1 = await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "Hi Grace", clientMessageId: "c-1" });
    expect(m1.status).toBe(201);
    const m1b = await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "Hi Grace", clientMessageId: "c-1" });
    expect(m1b.status).toBe(200);
    expect((await j(m1b)).id).toBe((await j(m1)).id);
    const before = (await owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'ai.respond'`)[0]!.n;
    const mc = await j<{ id: string }>(await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "I want a demo", sender: "contact" }));
    const after = await owner`SELECT payload FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'ai.respond' ORDER BY created_at DESC LIMIT 1`;
    expect((await owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'ai.respond'`)[0]!.n).toBe(before + 1);
    expect(after[0]!.payload).toMatchObject({ conversationId: conv.id, messageId: mc.id });
    await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "private note", sender: "note" });
    expect((await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "" })).status).toBe(400);
    expect((await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "x", sender: "ai" })).status).toBe(400);

    const msgs = await j<{ items: { senderType: string; content: string }[] }>(await pub("GET", `/conversations/${conv.id}/messages`, key));
    expect(msgs.items.map((m) => m.content)).toEqual(["Hi Grace", "I want a demo"]); // no notes
    expect((await j<{ items: { id: string }[] }>(await pub("GET", `/conversations?contactId=${c1.id}`, key))).items.map((x) => x.id)).toEqual([conv.id]);
    expect((await pub("GET", `/conversations?status=bogus`, key)).status).toBe(400);

    const [bk] = await owner<{ id: string }[]>`INSERT INTO bookings (tenant_id, title, start_at, end_at, contact_id, conversation_id)
      VALUES (${A.tenantId}, 'Demo', now() + interval '1 day', now() + interval '1 day 30 minutes', ${c1.id}, ${conv.id}) RETURNING id`;
    const bl = await j<{ items: { id: string; title: string }[] }>(await pub("GET", "/bookings", key));
    expect(bl.items.map((b) => b.id)).toContain(bk!.id);
    expect((await pub("GET", `/bookings/${bk!.id}`, key)).status).toBe(200);

    // booking writes need their own scope; manual booking when no calendar is connected; overlaps are refused
    expect((await pub("POST", "/bookings", key, { startAt: "2030-01-01T10:00:00Z" })).status).toBe(403);
    const wkey = await mkKey(A, ["bookings:read", "bookings:write"]);
    expect((await pub("POST", "/bookings", wkey, { startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T09:00:00Z" })).status).toBe(400);
    expect((await pub("POST", "/bookings", wkey, { startAt: "2030-01-01T10:00:00Z", extra: 1 })).status).toBe(400);
    expect((await pub("POST", "/bookings", wkey, { startAt: "2030-01-01T10:00:00Z", contactId: crypto.randomUUID() })).status).toBe(400);
    const made = await pub("POST", "/bookings", wkey, { startAt: "2030-01-01T10:00:00Z", durationMinutes: 30, contactId: c1.id, conversationId: conv.id, title: "API demo" });
    expect(made.status).toBe(201);
    const nb = await j<{ id: string; status: string; provider: string | null; contactId: string }>(made);
    expect(nb).toMatchObject({ status: "booked", provider: null, contactId: c1.id });
    expect((await pub("POST", "/bookings", wkey, { startAt: "2030-01-01T10:15:00Z", durationMinutes: 30 })).status).toBe(409);
    const keyBw = await mkKey(B, ["bookings:read", "bookings:write"]);
    expect((await pub("POST", `/bookings/${nb.id}/cancel`, keyBw, {})).status).toBe(404);
    expect((await pub("POST", `/bookings/${nb.id}/cancel`, key, {})).status).toBe(403);
    expect(await j(await pub("POST", `/bookings/${nb.id}/cancel`, wkey, { reason: "customer asked" }))).toMatchObject({ id: nb.id, status: "cancelled" });
    expect((await pub("POST", `/bookings/${nb.id}/cancel`, wkey, {})).status).toBe(409);
    expect((await pub("POST", "/bookings", wkey, { startAt: "2030-01-01T10:15:00Z", durationMinutes: 30 })).status).toBe(201); // slot free again

    // tenant B's key cannot reach any of it
    for (const p of [`/contacts/${c1.id}`, `/conversations/${conv.id}`, `/conversations/${conv.id}/messages`, `/bookings/${bk!.id}`]) {
      expect([p, (await pub("GET", p, keyB)).status]).toEqual([p, 404]);
    }
    expect((await pub("PATCH", `/contacts/${c1.id}`, keyB, { name: "hijack" })).status).toBe(404);
    expect((await pub("POST", `/conversations/${conv.id}/messages`, keyB, { text: "x" })).status).toBe(404);
    expect((await pub("POST", "/conversations", keyB, { contactId: c1.id })).status).toBe(404);
    expect((await j<{ items: unknown[] }>(await pub("GET", "/bookings", keyB))).items).toEqual([]);
    expect((await j<{ items: { id: string }[] }>(await pub("GET", "/contacts", keyB))).items.map((x) => x.id)).not.toContain(c1.id);

    const au = await owner`SELECT action, actor_user_id, metadata FROM audit_logs WHERE tenant_id = ${A.tenantId} AND resource_id = ${c1.id}`;
    expect(au.map((a) => a.action)).toEqual(expect.arrayContaining(["contact.create", "contact.update"]));
    expect(au.every((a) => a.actor_user_id === null && a.metadata.via === "public_api" && a.metadata.apiKeyId)).toBe(true);
  });

  // ------------------------------------------------------------------ GDPR
  test("GDPR export: async job, contact scoped, signed/streamed download, expiry, roles, cross-tenant", async () => {
    const T = await mkTenant("gdprA");
    const U = await mkTenant("gdprB");
    const key = await mkKey(T, ["contacts:write", "conversations:write"]);
    const contact = await j<{ id: string }>(await pub("POST", "/contacts", key, { name: "Eve Export", email: "eve@example.test" }));
    const other = await j<{ id: string }>(await pub("POST", "/contacts", key, { name: "Someone Else", email: "else@example.test" }));
    const conv = await j<{ id: string }>(await pub("POST", "/conversations", key, { contactId: contact.id }));
    const otherConv = await j<{ id: string }>(await pub("POST", "/conversations", key, { contactId: other.id }));
    await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "my secret question", sender: "contact" });
    await pub("POST", `/conversations/${otherConv.id}/messages`, key, { text: "unrelated chatter", sender: "contact" });

    const agent = await addUser(T, "agent");
    expect((await api("POST", "/gdpr/exports", agent.h, {})).status).toBe(403);
    expect((await api("POST", "/gdpr/exports", T.h, { contactId: crypto.randomUUID() })).status).toBe(404);
    expect((await api("POST", "/gdpr/exports", U.h, { contactId: contact.id })).status).toBe(404); // other tenant's contact
    expect((await api("POST", "/gdpr/exports", T.h, { contactId: contact.id, extra: 1 })).status).toBe(400);

    const created = await api("POST", "/gdpr/exports", T.h, { contactId: contact.id });
    expect(created.status).toBe(202);
    const rq = await j<{ id: string; status: string; downloadAvailable: boolean }>(created);
    expect(rq).toMatchObject({ status: "queued", downloadAvailable: false });
    expect((await api("GET", `/gdpr/requests/${rq.id}/download`, T.h)).status).toBe(404); // not ready yet
    await drain();
    const done = await j(await api("GET", `/gdpr/requests/${rq.id}`, T.h));
    expect(done).toMatchObject({ status: "completed", downloadAvailable: true, contactId: contact.id });
    expect(done.result.counts.messages).toBe(1);

    const signed = await j<{ url: string; expiresAt: string }>(await api("GET", `/gdpr/requests/${rq.id}/download`, T.h));
    expect(signed.url).toBe(`memory://gdpr/${T.tenantId}/${rq.id}.json`);
    expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    presign = false;
    const dl = await api("GET", `/gdpr/requests/${rq.id}/download`, T.h);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("cache-control")).toBe("no-store");
    const file = await j<{ scope: string; data: Record<string, any[]> }>(dl); // memory storage can't presign => streamed
    expect(file.scope).toBe("contact");
    expect(file.data.contacts!.map((c) => c.email)).toEqual(["eve@example.test"]);
    expect(file.data.messages!.map((m) => m.content)).toEqual(["my secret question"]);
    expect(JSON.stringify(file)).not.toContain("unrelated chatter");
    expect(JSON.stringify(file)).not.toContain("Someone Else");

    expect((await api("GET", `/gdpr/requests/${rq.id}`, U.h)).status).toBe(404);
    expect((await api("GET", `/gdpr/requests/${rq.id}/download`, U.h)).status).toBe(404);
    expect((await j<{ items: unknown[] }>(await api("GET", "/gdpr/requests", U.h))).items).toEqual([]);
    expect((await j<{ items: { id: string }[] }>(await api("GET", "/gdpr/requests?kind=export", T.h))).items.map((x) => x.id)).toEqual([rq.id]);
    const acts = (await owner`SELECT action FROM audit_logs WHERE tenant_id = ${T.tenantId} AND action LIKE 'gdpr.%'`).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["gdpr.export.requested", "gdpr.export.completed", "gdpr.export.downloaded"]));

    // expired exports are refused and swept from storage
    await owner`UPDATE gdpr_requests SET expires_at = now() - interval '1 minute' WHERE id = ${rq.id}`;
    expect((await api("GET", `/gdpr/requests/${rq.id}/download`, T.h)).status).toBe(404);
    const swept = await runRetention(db, { storage: providers.storage });
    expect(swept.exportFiles).toBeGreaterThanOrEqual(1);
    expect(await providers.storage.exists(`gdpr/${T.tenantId}/${rq.id}.json`)).toBe(false);

    // workspace export: no credentials or secrets in the file
    await mkHook(T);
    const ws = await j<{ id: string }>(await api("POST", "/gdpr/exports", T.h, {}));
    await drain();
    presign = false;
    const wsFile = JSON.stringify(await j(await api("GET", `/gdpr/requests/${ws.id}/download`, T.h)));
    expect(wsFile).toContain("eve@example.test");
    expect(wsFile).toContain("unrelated chatter");
    expect(wsFile).not.toMatch(/password_hash|passwordHash|key_hash|keyHash|secret_encrypted|secretEncrypted|whsec_/);
  });

  test("GDPR erasure: anonymises the contact everywhere, kills old exports, stays silent, leaves others intact", async () => {
    const T = await mkTenant("eraseA");
    const U = await mkTenant("eraseB");
    const key = await mkKey(T, ["contacts:write", "conversations:write"]);
    const hook = await mkHook(T, ["*"]);
    const contact = await j<{ id: string }>(await pub("POST", "/contacts", key, { name: "Zed Erase", email: "zed@example.test", phone: "+251900000001", customAttributes: { company: "Acme" } }));
    const keep = await j<{ id: string }>(await pub("POST", "/contacts", key, { name: "Keep Me", email: "keep@example.test" }));
    const conv = await j<{ id: string }>(await pub("POST", "/conversations", key, { contactId: contact.id }));
    const keepConv = await j<{ id: string }>(await pub("POST", "/conversations", key, { contactId: keep.id }));
    await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "my card is 4111", sender: "contact" });
    await pub("POST", `/conversations/${conv.id}/messages`, key, { text: "agent note about Zed", sender: "note" });
    await pub("POST", `/conversations/${keepConv.id}/messages`, key, { text: "keep this text", sender: "contact" });
    await owner`INSERT INTO contact_identities (tenant_id, contact_id, channel, external_id) VALUES (${T.tenantId}, ${contact.id}, 'whatsapp', '+251900000001')`;
    await owner`INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary, lead_card) VALUES (${T.tenantId}, ${conv.id}, 'stage', 'r', 'Zed wants pricing', '{"budget":"10k"}')`;
    await owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, lead) VALUES (${T.tenantId}, ${conv.id}, '{"email":"zed@example.test"}')`;
    await owner`INSERT INTO tool_executions (tenant_id, conversation_id, tool_name, input, output, success) VALUES (${T.tenantId}, ${conv.id}, 'collect_contact', '{"email":"zed@example.test"}', '{"ok":true}', true)`;

    // an earlier export of this contact must not survive the erasure
    const ex = await j<{ id: string }>(await api("POST", "/gdpr/exports", T.h, { contactId: contact.id }));
    await drain();
    const exKey = `gdpr/${T.tenantId}/${ex.id}.json`;
    expect(await providers.storage.exists(exKey)).toBe(true);
    await drain(); // flush webhook deliveries generated by the setup above
    const deliveriesBefore = (await deliveries(T.tenantId, hook.id)).length;

    expect((await api("POST", "/gdpr/erasures", T.h, { contactId: contact.id })).status).toBe(400); // confirm required
    expect((await api("POST", "/gdpr/erasures", T.h, { contactId: contact.id, confirm: false })).status).toBe(400);
    expect((await api("POST", "/gdpr/erasures", (await addUser(T, "agent")).h, { contactId: contact.id, confirm: true })).status).toBe(403);
    expect((await api("POST", "/gdpr/erasures", U.h, { contactId: contact.id, confirm: true })).status).toBe(404);

    const rq = await j<{ id: string }>(await api("POST", "/gdpr/erasures", T.h, { contactId: contact.id, confirm: true }));
    await drain();
    const st = await j(await api("GET", `/gdpr/requests/${rq.id}`, T.h));
    expect(st).toMatchObject({ kind: "erasure", status: "completed" });
    expect(st.result).toMatchObject({ contacts: 1, messagesRedacted: 2, identitiesDeleted: 1, conversations: 1 });

    const [c] = await owner`SELECT name, email, phone, custom_attributes FROM contacts WHERE id = ${contact.id}`;
    expect(c).toMatchObject({ name: null, email: null, phone: null });
    expect(c!.custom_attributes).toEqual({ erased: true });
    expect((await owner`SELECT 1 FROM contact_identities WHERE contact_id = ${contact.id}`).length).toBe(0);
    const ms = await owner`SELECT content, ui, metadata FROM messages WHERE conversation_id = ${conv.id}`;
    expect(ms.every((m) => m.content === "[erased]" && m.ui === null)).toBe(true);
    expect((await owner`SELECT last_message_preview, metadata FROM conversations WHERE id = ${conv.id}`)[0]).toMatchObject({ last_message_preview: null, metadata: {} });
    expect((await owner`SELECT summary, lead_card FROM handoffs WHERE conversation_id = ${conv.id}`)[0]).toMatchObject({ summary: null, lead_card: null });
    expect((await owner`SELECT lead FROM conversation_ai_state WHERE conversation_id = ${conv.id}`)[0]!.lead).toEqual({});
    expect((await owner`SELECT input, output FROM tool_executions WHERE conversation_id = ${conv.id}`)[0]).toMatchObject({ input: {}, output: null });
    // previous export gone from storage
    expect(await providers.storage.exists(exKey)).toBe(false);
    expect((await api("GET", `/gdpr/requests/${ex.id}/download`, T.h)).status).toBe(404);
    // others untouched
    expect((await owner`SELECT name, email FROM contacts WHERE id = ${keep.id}`)[0]).toMatchObject({ name: "Keep Me", email: "keep@example.test" });
    expect((await owner`SELECT content FROM messages WHERE conversation_id = ${keepConv.id}`)[0]!.content).toBe("keep this text");
    // erasure itself emits no contact.updated webhooks (it would re-leak the subject)
    await drain();
    expect((await deliveries(T.tenantId, hook.id)).length).toBe(deliveriesBefore);
    expect((await owner`SELECT action FROM audit_logs WHERE tenant_id = ${T.tenantId} AND action = 'gdpr.erasure.completed'`).length).toBe(1);
    // idempotent: a second erasure of the same contact completes cleanly
    const rq2 = await j<{ id: string }>(await api("POST", "/gdpr/erasures", T.h, { contactId: contact.id, confirm: true }));
    await drain();
    expect((await j(await api("GET", `/gdpr/requests/${rq2.id}`, T.h))).status).toBe("completed");
  });

  test("the erase function refuses to run against another tenant", async () => {
    const T = await mkTenant("guardA");
    const U = await mkTenant("guardB");
    const [c] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${T.tenantId}, 'victim') RETURNING id`;
    const { withTenant } = await import("@yulona/db");
    await expect(withTenant(db, U.tenantId, (tx) => tx`SELECT gdpr_erase_contact(${T.tenantId}::uuid, ${c!.id}::uuid)`)).rejects.toThrow(/tenant mismatch/);
    await expect((async () => db`SELECT gdpr_erase_contact(${T.tenantId}::uuid, ${c!.id}::uuid)`)()).rejects.toThrow(/tenant mismatch/); // no tenant context at all
    expect((await owner`SELECT name FROM contacts WHERE id = ${c!.id}`)[0]!.name).toBe("victim");
    // webhook_emit is equally tenant-bound
    await mkHook(T, ["*"]);
    const n = await withTenant(db, U.tenantId, (tx) => tx<{ n: number }[]>`SELECT webhook_emit(${T.tenantId}::uuid, 'contact.created', '{}'::jsonb) AS n`);
    expect(n[0]!.n).toBe(0);
  });

  // ------------------------------------------------------------------ retention
  test("retention policy API + sweep: old idle messages, audit and tool logs removed; recent data and live conversations kept", async () => {
    const T = await mkTenant("retA");
    const U = await mkTenant("retB");
    const agent = await addUser(T, "agent");
    expect((await api("GET", "/retention", agent.h)).status).toBe(403);
    expect(await j(await api("GET", "/retention", T.h))).toMatchObject({ messagesDays: null, defaults: { webhookLogsDays: 30 } });
    for (const bad of [{ messagesDays: 1, auditLogsDays: null, webhookLogsDays: null, toolLogsDays: null }, { messagesDays: 30 }, { messagesDays: 30, auditLogsDays: 30, webhookLogsDays: 0, toolLogsDays: null }]) {
      expect((await api("PUT", "/retention", T.h, bad)).status).toBe(400);
    }
    const put = await api("PUT", "/retention", T.h, { messagesDays: 30, auditLogsDays: 90, webhookLogsDays: 7, toolLogsDays: 30 });
    expect(await j(put)).toMatchObject({ messagesDays: 30, auditLogsDays: 90, webhookLogsDays: 7, toolLogsDays: 30 });
    expect(await j(await api("GET", "/retention", U.h))).toMatchObject({ messagesDays: null }); // not shared across tenants

    const [ct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${T.tenantId}, 'r') RETURNING id`;
    const mkConv = async (lastMsgDaysAgo: number) => {
      const [c] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, last_message_at) VALUES (${T.tenantId}, ${ct!.id}, now() - make_interval(days => ${lastMsgDaysAgo})) RETURNING id`;
      return c!.id;
    };
    const idle = await mkConv(60), live = await mkConv(1);
    const insMsg = (conv: string, daysAgo: number, text: string) =>
      owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, created_at) VALUES (${T.tenantId}, ${conv}, 'contact', ${text}, now() - make_interval(days => ${daysAgo}))`;
    await insMsg(idle, 61, "old idle 1");
    await insMsg(idle, 60, "old idle 2");
    await insMsg(live, 45, "old but live conversation");
    await insMsg(live, 0, "fresh");
    // the insert trigger moves last_message_at; pin it: `idle` has been quiet for 60 days, `live` spoke yesterday
    await owner`UPDATE conversations SET last_message_at = now() - interval '60 days', last_message_preview = 'old idle 2' WHERE id = ${idle}`;
    await owner`UPDATE conversations SET last_message_at = now() - interval '1 day' WHERE id = ${live}`;
    await owner`INSERT INTO audit_logs (tenant_id, action, created_at) VALUES (${T.tenantId}, 'old.audit', now() - interval '100 days'), (${T.tenantId}, 'recent.audit', now() - interval '10 days')`;
    await owner`INSERT INTO tool_executions (tenant_id, tool_name, success, created_at) VALUES (${T.tenantId}, 'old', true, now() - interval '40 days'), (${T.tenantId}, 'new', true, now() - interval '2 days')`;
    // another tenant with no policy keeps everything
    const [uct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${U.tenantId}, 'u') RETURNING id`;
    const [uc] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, last_message_at) VALUES (${U.tenantId}, ${uct!.id}, now() - interval '400 days') RETURNING id`;
    await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, created_at) VALUES (${U.tenantId}, ${uc!.id}, 'contact', 'ancient', now() - interval '400 days')`;
    // webhook logs: tenant policy 7 days (T) vs default 30 days (U); pending deliveries are never purged
    const hT = await mkHook(T, ["contact.created"]);
    const hU = await mkHook(U, ["contact.created"]);
    const ins = (t: string, h: string, status: string, days: number) => owner`INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, status, created_at)
      VALUES (${t}, ${h}, gen_random_uuid(), 'contact.created', '{}', ${status}, now() - make_interval(days => ${days}))`;
    await ins(T.tenantId, hT.id, "succeeded", 10); await ins(T.tenantId, hT.id, "succeeded", 3); await ins(T.tenantId, hT.id, "retrying", 20);
    await ins(U.tenantId, hU.id, "succeeded", 10); await ins(U.tenantId, hU.id, "failed", 40);

    const r = await runRetention(db, { batch: 1 }); // batch of 1 exercises the repeat-until-drained loop
    expect(r.messages).toBeGreaterThanOrEqual(2);
    const msgs = (await owner`SELECT content FROM messages WHERE tenant_id = ${T.tenantId} ORDER BY content`).map((m) => m.content);
    expect(msgs).toEqual(["fresh", "old but live conversation"]); // live conversation keeps its history
    expect((await owner`SELECT last_message_preview FROM conversations WHERE id = ${idle}`)[0]!.last_message_preview).toBeNull();
    expect((await owner`SELECT action FROM audit_logs WHERE tenant_id = ${T.tenantId} AND action IN ('old.audit','recent.audit')`).map((a) => a.action)).toEqual(["recent.audit"]);
    expect((await owner`SELECT tool_name FROM tool_executions WHERE tenant_id = ${T.tenantId}`).map((a) => a.tool_name)).toEqual(["new"]);
    expect((await owner`SELECT status FROM webhook_deliveries WHERE tenant_id = ${T.tenantId} AND event_type = 'contact.created' ORDER BY status`).map((d) => d.status)).toEqual(["retrying", "succeeded"]);
    expect((await owner`SELECT status FROM webhook_deliveries WHERE tenant_id = ${U.tenantId} ORDER BY created_at`).map((d) => d.status)).toEqual(["succeeded"]);
    expect((await owner`SELECT content FROM messages WHERE tenant_id = ${U.tenantId}`).map((m) => m.content)).toEqual(["ancient"]);
  });

  // ------------------------------------------------------------------ RLS on the new tables
  test("RLS: the app role sees only its own rows in every new table and cannot write across tenants", async () => {
    const T = await mkTenant("rlsA");
    const U = await mkTenant("rlsB");
    const hook = await mkHook(T, ["contact.created"]);
    await api("POST", `/webhooks/${hook.id}/test`, T.h, {});
    await api("POST", "/gdpr/exports", T.h, {});
    await api("PUT", "/retention", T.h, { messagesDays: 30, auditLogsDays: null, webhookLogsDays: null, toolLogsDays: null });
    const { withTenant } = await import("@yulona/db");
    for (const table of ["webhooks", "webhook_deliveries", "gdpr_requests", "retention_policies"]) {
      const rows = await withTenant(db, U.tenantId, (tx) => tx.unsafe(`SELECT 1 FROM ${table} WHERE tenant_id = '${T.tenantId}'`));
      expect([table, rows.length]).toEqual([table, 0]);
      expect([table, (await db.unsafe(`SELECT 1 FROM ${table}`)).length]).toEqual([table, 0]); // no tenant context => nothing
    }
    await expect(withTenant(db, U.tenantId, (tx) => tx`INSERT INTO webhooks (tenant_id, name, url, secret_encrypted, events) VALUES (${T.tenantId}, 'x', 'https://x.test', 'x', ARRAY['*'])`)).rejects.toThrow();
  });

  test("the 30-day tenant hard-delete purge also clears webhook, GDPR and retention rows", async () => {
    const T = await mkTenant("purge");
    const hook = await mkHook(T, ["contact.created"]);
    await api("POST", `/webhooks/${hook.id}/test`, T.h, {});
    await drain();
    await api("POST", "/gdpr/exports", T.h, {});
    await api("PUT", "/retention", T.h, { messagesDays: 30, auditLogsDays: null, webhookLogsDays: null, toolLogsDays: null });
    expect((await owner`SELECT count(*)::int AS n FROM webhook_delivery_attempts WHERE tenant_id = ${T.tenantId}`)[0]!.n).toBe(1);
    await owner`UPDATE tenants SET status = 'deleted', deleted_at = now() - interval '31 days' WHERE id = ${T.tenantId}`;
    await db`SELECT platform_purge_deleted_tenants()`;
    expect((await owner`SELECT 1 FROM tenants WHERE id = ${T.tenantId}`).length).toBe(0);
    for (const t of ["webhooks", "webhook_deliveries", "webhook_delivery_attempts", "gdpr_requests", "retention_policies"]) {
      expect([t, (await owner.unsafe(`SELECT 1 FROM ${t} WHERE tenant_id = '${T.tenantId}'`)).length]).toEqual([t, 0]);
    }
  });

  // ------------------------------------------------------------------ OpenAPI
  test("OpenAPI: integration + knowledge paths documented, unique operationIds, declared path params, secured", () => {
    const doc = buildOpenApi() as unknown as { paths: Record<string, Record<string, any>>; servers: unknown[]; components: { securitySchemes: Record<string, unknown> } };
    for (const p of ["/api/v1/webhooks", "/api/v1/webhook-deliveries/{id}/redeliver", "/api/v1/gdpr/exports", "/api/v1/gdpr/requests/{id}/download", "/api/v1/retention",
      "/api/v1/public-api/contacts", "/api/v1/public-api/conversations/{id}/messages", "/api/v1/public-api/bookings", "/api/v1/knowledge/sources", "/api/v1/knowledge/sandbox"]) {
      expect([p, !!doc.paths[p]]).toEqual([p, true]);
    }
    expect(doc.paths["/api/v1/public-api/contacts"]!.get.security).toEqual([{ apiKeyAuth: [] }]);
    expect(doc.components.securitySchemes.apiKeyAuth).toBeTruthy();
    expect(doc.servers.length).toBe(1);
    const ids: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(item)) {
        ids.push(op.operationId);
        expect([m, path, typeof op.operationId]).toEqual([m, path, "string"]);
        expect(Object.keys(op.responses).length).toBeGreaterThan(0);
        for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
          expect([m, path, (op.parameters ?? []).some((q: any) => q.in === "path" && q.name === name)]).toEqual([m, path, true]);
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("OpenAPI covers every mounted route of this area (route table vs spec)", () => {
    const doc = buildOpenApi() as unknown as { paths: Record<string, Record<string, unknown>> };
    const mine = app.routes.filter((r) => /^\/api\/v1\/(webhooks(?!\/billing)|webhook-deliveries|gdpr|retention|public-api)/.test(r.path) && r.method !== "ALL");
    expect(mine.length).toBeGreaterThan(25);
    for (const r of mine) {
      const spec = r.path.replace(/:([A-Za-z]+)/g, "{$1}");
      expect([r.method, spec, !!doc.paths[spec]?.[r.method.toLowerCase()]]).toEqual([r.method, spec, true]);
    }
  });
});
