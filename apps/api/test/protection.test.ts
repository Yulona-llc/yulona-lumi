import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { verifyTurnstile } from "../src/conversations/turnstile";
import { createRealtime } from "../src/realtime/service";
import { signAccessToken } from "../src/security";
import { MemoryRateLimiter } from "../src/ratelimit";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const ORIGIN = "https://site.test";
const KEY = Buffer.alloc(32, 9).toString("base64");
const TS_SECRET = "1x0000000000000000000000000000000AA-secret";
type Tenant = { tenantId: string; userId: string; h: Record<string, string> };

describe.skipIf(!hasDb)("widget protection and abuse blocking", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let rt: ReturnType<typeof createRealtime>;
  let limiter: MemoryRateLimiter;
  let A: Tenant, B: Tenant;
  let fake: ReturnType<typeof Bun.serve>;
  const verifyCalls: { secret: string | null; response: string | null; remoteip: string | null }[] = [];
  let widget: { id: string; widgetKey: string };

  async function userOf(t: Tenant, role: "owner" | "admin" | "agent" | "viewer"): Promise<Tenant> {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t.tenantId}, ${`${role}-${crypto.randomUUID()}@example.test`}, ${role}, ${role}, 'x') RETURNING id`;
    const token = await signAccessToken(SECRET, { userId: u!.id, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { tenantId: t.tenantId, userId: u!.id, h: { authorization: `Bearer ${token}` } };
  }
  async function mkTenant(label: string): Promise<Tenant> {
    const t = await seedTenantWithUser(owner, label);
    await owner`UPDATE tenants SET plan_key = 'enterprise' WHERE id = ${t.tenantId}`;
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role: "owner", ttlSeconds: 900 });
    return { ...t, h: { authorization: `Bearer ${token}` } };
  }
  const send = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const pubH = (key: string, extra: Record<string, string> = {}) => ({ "x-widget-key": key, origin: ORIGIN, ...extra });
  const pub = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1/public/widget${path}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const start = (key: string, body: Record<string, unknown> = {}, ip = "198.51.100.1") => pub("POST", "/conversations", pubH(key, { "x-forwarded-for": ip }), body);

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = new URLSearchParams(await req.text());
        verifyCalls.push({ secret: form.get("secret"), response: form.get("response"), remoteip: form.get("remoteip") });
        if (new URL(req.url).pathname === "/slow") await Bun.sleep(400);
        const ok = form.get("secret") === TS_SECRET && form.get("response") === "good-token";
        return Response.json(ok ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] });
      },
    });
    const s = await setupTestDb();
    owner = s.owner; db = s.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({ ENCRYPTION_KEY: KEY }, (c) => {
      c.rateLimits.global = { limit: 1e6, windowMs: 60_000 };
      c.trustProxy = true;
      c.turnstileVerifyUrl = `http://localhost:${fake.port}/siteverify`;
    });
    const log = createLogger({ level: "silent" });
    rt = createRealtime({ db, log });
    app = createApp({ cfg, db, limiter, log, realtime: rt });
    A = await mkTenant("A");
    B = await mkTenant("B");
    const res = await send("POST", "/widgets", A.h, { name: "Main", allowedDomains: [ORIGIN] });
    expect(res.status).toBe(201);
    widget = await res.json();
  });
  afterAll(async () => {
    // do not leave pending notification emails behind: other suites dispatch from a shared queue (batch of 25)
    await owner`UPDATE notifications SET email_status = 'none' WHERE tenant_id IN (${A.tenantId}, ${B.tenantId}) AND email_status = 'pending'`;
    fake?.stop(true);
    await rt?.stop();
    limiter?.close();
    await db?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  // ------------------------------------------------------------ Turnstile settings
  test("Turnstile secret is write-only, encrypted, validated and owner/admin only", async () => {
    const turnstile = { enabled: true, siteKey: "0x4AAAAAAA-site_key", theme: "dark", size: "compact", appearance: "interaction-only", action: "chat_start" };
    // enabling without a secret is refused (it would lock every visitor out)
    let r = await send("PATCH", `/widgets/${widget.id}`, A.h, { config: { protection: { honeypot: true, turnstile } } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("secret");
    r = await send("PATCH", `/widgets/${widget.id}`, A.h, { config: { protection: { honeypot: true, turnstile } }, turnstileSecret: TS_SECRET });
    expect(r.status).toBe(200);
    const dto = await r.json() as Record<string, unknown> & { hasTurnstileSecret: boolean; config: { protection: { turnstile: { siteKey: string } } } };
    expect(dto.hasTurnstileSecret).toBe(true);
    expect(dto.config.protection.turnstile.siteKey).toBe("0x4AAAAAAA-site_key");
    expect(JSON.stringify(dto)).not.toContain(TS_SECRET);
    for (const path of [`/widgets/${widget.id}`, "/widgets"]) {
      expect(await (await send("GET", path, A.h)).text()).not.toContain(TS_SECRET);
    }
    const [row] = await owner<{ turnstile_secret_enc: string }[]>`SELECT turnstile_secret_enc FROM widgets WHERE id = ${widget.id}`;
    expect(row!.turnstile_secret_enc).toStartWith("v1.");
    expect(row!.turnstile_secret_enc).not.toContain(TS_SECRET);
    // public config exposes the site key (public by design) but never the secret
    const cfgRes = await pub("GET", "/config", pubH(widget.widgetKey));
    const cfgText = await cfgRes.text();
    expect(cfgText).toContain("0x4AAAAAAA-site_key");
    expect(cfgText).not.toContain(TS_SECRET);
    // removing the secret while Turnstile is on is refused; invalid keys are refused
    expect((await send("PATCH", `/widgets/${widget.id}`, A.h, { turnstileSecret: null })).status).toBe(400);
    expect((await send("PATCH", `/widgets/${widget.id}`, A.h, { config: { protection: { turnstile: { enabled: true, siteKey: "bad key!" } } } })).status).toBe(400);
    // roles + tenants
    const agent = await userOf(A, "agent");
    expect((await send("PATCH", `/widgets/${widget.id}`, agent.h, { turnstileSecret: "another-secret-value" })).status).toBe(403);
    expect((await send("PATCH", `/widgets/${widget.id}`, B.h, { turnstileSecret: "another-secret-value" })).status).toBe(404);
    const audit = await owner`SELECT metadata FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action = 'widget.update'`;
    expect(JSON.stringify(audit)).not.toContain(TS_SECRET);
  });

  test("Turnstile: missing, invalid and valid tokens; unreachable siteverify fails closed", async () => {
    verifyCalls.length = 0;
    let r = await start(widget.widgetKey);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("turnstile_failed");
    expect(verifyCalls).toHaveLength(0); // no token, nothing sent to Cloudflare
    r = await start(widget.widgetKey, { turnstileToken: "bad-token" });
    expect(r.status).toBe(403);
    r = await start(widget.widgetKey, { turnstileToken: "good-token" }, "203.0.113.9");
    expect(r.status).toBe(201);
    expect(verifyCalls.at(-1)).toEqual({ secret: TS_SECRET, response: "good-token", remoteip: "203.0.113.9" });
    // nothing was created for the failed attempts
    const [n] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${A.tenantId} AND widget_id = ${widget.id}`;
    expect(n!.n).toBe(1);
    // unreachable verifier => fail closed
    const down = await verifyTurnstile({ url: "http://localhost:1/siteverify", secret: "s", token: "good-token" });
    expect(down).toMatchObject({ ok: false, reason: "siteverify_unreachable" });
    // 5s timeout (shortened here): fail closed
    const slow = await verifyTurnstile({ url: `http://localhost:${fake.port}/slow`, secret: TS_SECRET, token: "good-token", timeoutMs: 100 });
    expect(slow).toMatchObject({ ok: false, reason: "siteverify_unreachable" });
    // a widget whose secret cannot be decrypted (key rotated / data damaged) also fails closed
    await owner`UPDATE widgets SET turnstile_secret_enc = 'v1.broken.broken' WHERE id = ${widget.id}`;
    expect((await start(widget.widgetKey, { turnstileToken: "good-token" })).status).toBe(403);
    // turn protection off again for the following tests
    await owner`UPDATE widgets SET config = '{}'::jsonb, turnstile_secret_enc = NULL WHERE id = ${widget.id}`;
  });

  // ------------------------------------------------------------ honeypot
  test("honeypot: a filled field gets a fake success and stores nothing; empty is fine; can be switched off", async () => {
    const before = (await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${A.tenantId}`)[0]!.n;
    const r = await start(widget.widgetKey, { hp: "http://spam.example" }, "198.51.100.77");
    expect(r.status).toBe(201);
    const fakeBody = await r.json() as { sessionToken: string };
    expect(fakeBody.sessionToken).toBeTruthy();
    expect((await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${A.tenantId}`)[0]!.n).toBe(before);
    // the fake token opens nothing
    expect((await pub("GET", "/messages", pubH(widget.widgetKey, { authorization: `Bearer ${fakeBody.sessionToken}` }))).status).toBe(401);
    // a real start works, and the honeypot on /messages drops the message
    const ok = await start(widget.widgetKey, { hp: "" }, "198.51.100.78");
    expect(ok.status).toBe(201);
    const real = await ok.json() as { sessionToken: string; conversation: { id: string } };
    const h = pubH(widget.widgetKey, { authorization: `Bearer ${real.sessionToken}` });
    const dropped = await pub("POST", "/messages", h, { text: "buy now", clientMessageId: "client-msg-0001", hp: "x" });
    expect(dropped.status).toBe(201);
    expect((await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${real.conversation.id} AND sender_type = 'contact'`)[0]!.n).toBe(0);
    const kept = await pub("POST", "/messages", h, { text: "hello", clientMessageId: "client-msg-0002" });
    expect(kept.status).toBe(201);
    // opt out per widget
    await send("PATCH", `/widgets/${widget.id}`, A.h, { config: { protection: { honeypot: false } } });
    expect((await start(widget.widgetKey, { hp: "filled" }, "198.51.100.79")).status).toBe(201);
    const stored = (await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${A.tenantId}`)[0]!.n;
    expect(stored).toBeGreaterThanOrEqual(3);
    await send("PATCH", `/widgets/${widget.id}`, A.h, { config: {} });
  });

  // ------------------------------------------------------------ blocking
  test("blocked visitor cannot start, reopen, send or resume; only owners/admins unblock; tenants are isolated", async () => {
    const ip = "198.51.100.50";
    const v1 = crypto.randomUUID();
    const s1 = await (await start(widget.widgetKey, { visitorId: v1 }, ip)).json() as { sessionToken: string; conversation: { id: string } };
    const h1 = pubH(widget.widgetKey, { authorization: `Bearer ${s1.sessionToken}` });
    expect((await pub("POST", "/messages", h1, { text: "hi", clientMessageId: "block-test-0001" })).status).toBe(201);
    const [conv] = await owner<{ contact_id: string }[]>`SELECT contact_id FROM conversations WHERE id = ${s1.conversation.id}`;
    const contactId = conv!.contact_id;

    const viewer = await userOf(A, "viewer");
    const agent = await userOf(A, "agent");
    const admin = await userOf(A, "admin");
    expect((await send("POST", `/contacts/${contactId}/block`, viewer.h, {})).status).toBe(403);
    expect((await send("POST", `/contacts/${contactId}/block`, B.h, {})).status).toBe(404); // cross-tenant
    expect((await send("POST", `/contacts/${contactId}/unblock`, B.h)).status).toBe(404);
    expect((await send("POST", `/contacts/${contactId}/block`, agent.h, { reason: "spamming links", extra: 1 })).status).toBe(400); // strict body
    const blocked = await send("POST", `/contacts/${contactId}/block`, agent.h, { reason: "spamming links" });
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ blockedReason: "spamming links", blockedBy: agent.userId });
    expect((await owner`SELECT revoked_at FROM widget_sessions WHERE conversation_id = ${s1.conversation.id}`)[0]!.revoked_at).not.toBeNull();

    // existing session, refreshed or not, is dead
    expect((await pub("POST", "/messages", h1, { text: "again", clientMessageId: "block-test-0002" })).status).toBe(401);
    // cannot start: same visitor id, and a brand-new visitor from the same IP shortly after a block
    let r = await start(widget.widgetKey, { visitorId: v1 }, "198.51.100.51");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("contact_blocked");
    expect((await start(widget.widgetKey, {}, ip)).status).toBe(403);
    expect((await start(widget.widgetKey, {}, "198.51.100.52")).status).toBe(201); // other networks are unaffected

    // a session that still looks valid (token not revoked) and a resolved conversation: nothing is stored, nothing reopens
    await owner`UPDATE widget_sessions SET revoked_at = NULL WHERE conversation_id = ${s1.conversation.id}`;
    await owner`UPDATE conversations SET status = 'resolved' WHERE id = ${s1.conversation.id}`;
    const msgCount = (await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${s1.conversation.id}`)[0]!.n;
    r = await pub("POST", "/messages", h1, { text: "let me back in", clientMessageId: "block-test-0003" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("contact_blocked");
    expect((await owner`SELECT status FROM conversations WHERE id = ${s1.conversation.id}`)[0]!.status).toBe("resolved");
    expect((await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${s1.conversation.id}`)[0]!.n).toBe(msgCount);

    // inbox: flag visible in the conversation list and contact; return-to-ai is refused
    const list = await (await send("GET", `/conversations?contactId=${contactId}`, A.h)).json() as { items: { contact: { blockedAt: string | null } }[] };
    expect(list.items[0]!.contact.blockedAt).not.toBeNull();
    expect((await send("POST", `/conversations/${s1.conversation.id}/return-to-ai`, agent.h)).status).toBe(409);
    expect(await (await send("GET", `/contacts/${contactId}`, A.h)).json()).toMatchObject({ blockedReason: "spamming links" });

    // only owners/admins unblock; agents cannot
    expect((await send("POST", `/contacts/${contactId}/unblock`, agent.h)).status).toBe(403);
    expect((await send("POST", `/contacts/${contactId}/unblock`, viewer.h)).status).toBe(403);
    const un = await send("POST", `/contacts/${contactId}/unblock`, admin.h);
    expect(un.status).toBe(200);
    expect(await un.json()).toMatchObject({ blockedAt: null, blockedReason: null, blockedBy: null });
    expect((await start(widget.widgetKey, { visitorId: v1 }, "198.51.100.53")).status).toBe(201);
    const audits = await owner<{ action: string }[]>`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND resource_id = ${contactId} AND action LIKE 'contact.%block'`;
    expect(audits.map((a) => a.action).sort()).toEqual(["contact.block", "contact.unblock"]);
  });

  test("a merged contact carries the blocked flag; abuse handoffs are counted and notify owners/admins", async () => {
    const mk = async () => (await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${A.tenantId}) RETURNING id`)[0]!.id;
    const primary = await mk(), source = await mk();
    await owner`UPDATE contacts SET blocked_at = now(), blocked_reason = 'abuse', blocked_by = NULL WHERE id = ${source}`;
    const m = await send("POST", `/contacts/${primary}/merge`, A.h, { sourceContactId: source });
    expect(m.status).toBe(200);
    expect(await m.json()).toMatchObject({ blockedReason: "abuse" });
    const [c] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, channel) VALUES (${A.tenantId}, ${primary}, 'widget') RETURNING id`;
    await owner`INSERT INTO handoffs (tenant_id, conversation_id, type, reason) VALUES (${A.tenantId}, ${c!.id}, 'abuse', 'Blocked for abuse: test')`;
    const counts = await (await send("GET", "/needs-attention/counts", A.h)).json() as { abuse: number; total: number };
    expect(counts.abuse).toBe(1);
    expect((await send("GET", "/needs-attention?type=abuse", A.h)).status).toBe(200);
    expect(((await (await send("GET", "/needs-attention/counts", B.h)).json()) as { abuse: number }).abuse).toBe(0);
    const notes = await owner<{ role: string; type: string }[]>`SELECT u.role, n.type FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.tenant_id = ${A.tenantId} AND n.type = 'handoff.abuse'`;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.role === "owner" || n.role === "admin")).toBe(true);
  });
});
