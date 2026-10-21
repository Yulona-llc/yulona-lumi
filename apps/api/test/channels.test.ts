import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { withTenant } from "@yulona/db";
import { startWorker } from "@yulona/queue";
import { createChannelJobHandlers, createDefaultRegistry } from "@yulona/channels";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { decryptCredentials } from "../src/conversations/crypto";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const ENC_KEY = Buffer.alloc(32, 9).toString("base64");
type Tenant = { tenantId: string; userId: string; h: Record<string, string> };
type Rec = { path: string; headers: Record<string, string>; body: any };

describe.skipIf(!hasDb)("channels", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let app: ReturnType<typeof createApp>;
  let limiter: MemoryRateLimiter;
  let A: Tenant, B: Tenant, agentUser: Tenant;
  let mock: ReturnType<typeof Bun.serve>;
  let seen: Rec[] = [];
  let respond: (path: string) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
  let registry: ReturnType<typeof createDefaultRegistry>;

  async function mk(label: string, role: "owner" | "agent" = "owner", existing?: { tenantId: string }): Promise<Tenant> {
    const t = existing
      ? await (async () => {
          const id = crypto.randomUUID().slice(0, 8);
          const [u] = await owner<{ id: string }[]>`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${existing.tenantId}, ${`${label}-${id}@example.test`}, ${label}, ${role}, 'x') RETURNING id`;
          return { tenantId: existing.tenantId, userId: u!.id };
        })()
      : await seedTenantWithUser(owner, label);
    if (!existing && role !== "owner") await owner`UPDATE users SET role = ${role} WHERE id = ${t.userId}`;
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { tenantId: t.tenantId, userId: t.userId, h: { authorization: `Bearer ${token}` } };
  }
  const api = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const hook = (channel: string, id: string, raw: string, headers: Record<string, string>) =>
    app.request(`/api/v1/webhooks/channels/${channel}/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });

  const waCreds = { accessToken: "wa-token-123456", phoneNumberId: "555", appSecret: "wa-app-secret", verifyToken: "wa-verify" };
  const metaSig = (secret: string, raw: string) => ({ "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` });
  const waPayload = (from: string, id: string, text: string, name = "Abebe") => JSON.stringify({
    entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
  });

  async function connect(t: Tenant, channel: string, credentials: Record<string, string>, extra: Record<string, unknown> = {}) {
    const res = await api("POST", "/channels/connections", t.h, { channel, name: `${channel} test`, credentials, ...extra });
    expect(res.status).toBe(201);
    return (await res.json()) as any;
  }
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;

  beforeAll(async () => {
    const s = await setupTestDb();
    owner = s.owner;
    db = s.app;
    mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const text = await req.text();
        const url = new URL(req.url);
        seen.push({ path: url.pathname, headers: Object.fromEntries(req.headers.entries()), body: text ? JSON.parse(text) : null });
        const r = respond(url.pathname);
        return Response.json(r.json, { status: r.status });
      },
    });
    const apiBase = `http://localhost:${mock.port}`;
    registry = createDefaultRegistry({ apiBases: { whatsapp: apiBase, facebook: apiBase, instagram: apiBase, telegram: apiBase, slack: apiBase } });
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({ ENCRYPTION_KEY: ENC_KEY, PUBLIC_API_URL: "https://api.yulona.test" });
    app = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }), channelRegistry: registry });
    A = await mk("chA");
    B = await mk("chB");
    agentUser = await mk("chAgent", "agent", A);
  });
  afterAll(async () => {
    mock.stop(true);
    limiter.close();
    await db.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });
  beforeEach(() => {
    seen = [];
    respond = () => ({ status: 200, json: {} });
  });

  describe("connection management", () => {
    test("create masks secrets, encrypts at rest, returns webhook url; secrets never in responses", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      expect(c.webhookUrl).toBe(`https://api.yulona.test/api/v1/webhooks/channels/whatsapp/${c.id}`);
      expect(c.credentialsMasked.accessToken).toBe("••••3456");
      expect(c.credentialsMasked.phoneNumberId).toBe("555");
      expect(c.externalId).toBe("555");
      expect(JSON.stringify(c)).not.toContain("wa-token-123456");
      expect(JSON.stringify(c)).not.toContain("wa-app-secret");
      const [row] = await owner<{ credentials_encrypted: string }[]>`SELECT credentials_encrypted FROM channel_connections WHERE id = ${c.id}`;
      expect(row!.credentials_encrypted.startsWith("v1.")).toBe(true);
      expect(row!.credentials_encrypted).not.toContain("wa-token");
      expect(decryptCredentials(ENC_KEY, row!.credentials_encrypted, `${A.tenantId}:${c.id}`).accessToken).toBe("wa-token-123456");
      // list + get also masked
      const list = await (await api("GET", "/channels/connections", A.h)).json() as any;
      expect(JSON.stringify(list)).not.toContain("wa-token-123456");
      const one = await (await api("GET", `/channels/connections/${c.id}`, A.h)).json() as any;
      expect(one.credentialsMasked.appSecret).toBe("••••cret");
    });
    test("generates webhook secrets when omitted and returns them once", async () => {
      const c = await connect(A, "telegram", { botToken: "111:AAA-bot-token" });
      expect(c.generatedSecrets.webhookSecret.length).toBeGreaterThan(20);
      const again = await (await api("GET", `/channels/connections/${c.id}`, A.h)).json() as any;
      expect(again.generatedSecrets).toBeUndefined();
      expect(again.credentialsMasked.webhookSecret).toBeDefined();
    });
    test("validation: strict body, unknown/missing credentials, unsupported channel, unknown agent", async () => {
      expect((await api("POST", "/channels/connections", A.h, { channel: "whatsapp", name: "x", credentials: { accessToken: "t" } })).status).toBe(400);
      expect((await api("POST", "/channels/connections", A.h, { channel: "telegram", name: "x", credentials: { botToken: "t", evil: "1" } })).status).toBe(400);
      expect((await api("POST", "/channels/connections", A.h, { channel: "widget", name: "x", credentials: {} })).status).toBe(400);
      expect((await api("POST", "/channels/connections", A.h, { channel: "telegram", name: "x", credentials: { botToken: "t" }, tenantId: B.tenantId })).status).toBe(400);
      expect((await api("POST", "/channels/connections", A.h, { channel: "telegram", name: "x", credentials: { botToken: "t" }, agentId: crypto.randomUUID() })).status).toBe(400);
    });
    test("RBAC: agent can read, cannot write; unauthenticated 401", async () => {
      const c = await connect(A, "telegram", { botToken: "rbac-token-1" });
      expect((await api("GET", "/channels/connections", agentUser.h)).status).toBe(200);
      expect((await api("POST", "/channels/connections", agentUser.h, { channel: "telegram", name: "x", credentials: { botToken: "t" } })).status).toBe(403);
      expect((await api("PATCH", `/channels/connections/${c.id}`, agentUser.h, { name: "n" })).status).toBe(403);
      expect((await api("DELETE", `/channels/connections/${c.id}`, agentUser.h)).status).toBe(403);
      expect((await api("POST", `/channels/connections/${c.id}/test`, agentUser.h)).status).toBe(403);
      expect((await api("GET", "/channels/connections", {})).status).toBe(401);
    });
    test("cross-tenant: B cannot see, read, change, test or delete A's connection", async () => {
      const c = await connect(A, "telegram", { botToken: "xt-token-1" });
      const list = await (await api("GET", "/channels/connections", B.h)).json() as any;
      expect(list.items.find((i: any) => i.id === c.id)).toBeUndefined();
      expect((await api("GET", `/channels/connections/${c.id}`, B.h)).status).toBe(404);
      expect((await api("PATCH", `/channels/connections/${c.id}`, B.h, { name: "hack" })).status).toBe(404);
      expect((await api("POST", `/channels/connections/${c.id}/test`, B.h)).status).toBe(404);
      expect((await api("DELETE", `/channels/connections/${c.id}`, B.h)).status).toBe(404);
      expect((await api("GET", `/channels/connections/not-a-uuid`, B.h)).status).toBe(404);
      const still = await api("GET", `/channels/connections/${c.id}`, A.h);
      expect(((await still.json()) as any).name).not.toBe("hack");
    });
    test("patch rotates a single secret and keeps the rest; disable; audit log", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const r = await api("PATCH", `/channels/connections/${c.id}`, A.h, { credentials: { accessToken: "rotated-token-9999" }, status: "disabled" });
      expect(r.status).toBe(200);
      const [row] = await owner<{ credentials_encrypted: string; status: string }[]>`SELECT credentials_encrypted, status FROM channel_connections WHERE id = ${c.id}`;
      expect(row!.status).toBe("disabled");
      expect(decryptCredentials(ENC_KEY, row!.credentials_encrypted, `${A.tenantId}:${c.id}`)).toMatchObject({ accessToken: "rotated-token-9999", appSecret: "wa-app-secret" });
      expect(await count(owner`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ${A.tenantId} AND resource_id = ${c.id}`)).toBeGreaterThanOrEqual(2);
    });
    test("health check records result and flips status", async () => {
      const c = await connect(A, "telegram", { botToken: "hc-token-1" });
      respond = () => ({ status: 200, json: { ok: true, result: { username: "yulona_bot" } } });
      let r = await (await api("POST", `/channels/connections/${c.id}/test`, A.h)).json() as any;
      expect(r).toMatchObject({ ok: true, detail: "Bot @yulona_bot" });
      respond = () => ({ status: 401, json: {} });
      r = await (await api("POST", `/channels/connections/${c.id}/test`, A.h)).json() as any;
      expect(r.ok).toBe(false);
      const got = await (await api("GET", `/channels/connections/${c.id}`, A.h)).json() as any;
      expect(got.status).toBe("error");
      expect(got.health.ok).toBe(false);
    });
    test("available lists capabilities and fields; delete keeps conversation history", async () => {
      const av = await (await api("GET", "/channels/available", A.h)).json() as any;
      expect(av.items.map((i: any) => i.channel).sort()).toEqual(["facebook", "instagram", "slack", "telegram", "whatsapp"]);
      expect(av.items.find((i: any) => i.channel === "whatsapp").capabilities.messageWindow).toBe(24);
      const c = await connect(A, "whatsapp", waCreds);
      await hook("whatsapp", c.id, waPayload("251900000001", "wamid.del", "hi"), metaSig(waCreds.appSecret, waPayload("251900000001", "wamid.del", "hi")));
      expect((await api("DELETE", `/channels/connections/${c.id}`, A.h)).status).toBe(200);
      expect(await count(owner`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${A.tenantId} AND channel = 'whatsapp' AND channel_connection_id IS NULL`)).toBeGreaterThanOrEqual(1);
      const empty = await connect(A, "telegram", { botToken: "del-token-1" });
      expect((await api("DELETE", `/channels/connections/${empty.id}`, A.h)).status).toBe(200);
    });
  });

  describe("WhatsApp webhook", () => {
    test("handshake: right token echoes challenge, wrong token 403, other tenant's id 404 path", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const q = (t: string) => app.request(`/api/v1/webhooks/channels/whatsapp/${c.id}?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=777`);
      const ok = await q("wa-verify");
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("777");
      expect((await q("nope")).status).toBe(403);
      expect((await app.request(`/api/v1/webhooks/channels/whatsapp/${crypto.randomUUID()}?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=1`)).status).toBe(404);
    });
    test("bad/missing signature => 401 and nothing stored", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const raw = waPayload("251911111111", "wamid.bad", "evil");
      expect((await hook("whatsapp", c.id, raw, {})).status).toBe(401);
      expect((await hook("whatsapp", c.id, raw, metaSig("wrong", raw))).status).toBe(401);
      expect((await hook("whatsapp", c.id, raw + " ", metaSig(waCreds.appSecret, raw))).status).toBe(401);
      expect(await count(owner`SELECT count(*)::int AS n FROM contact_identities WHERE tenant_id = ${A.tenantId} AND external_id = '251911111111'`)).toBe(0);
    });
    test("inbound creates contact, identity, conversation, message and an ai.respond job; replay is dropped", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const raw = waPayload("251922222222", "wamid.ok1", "I need pricing");
      const res = await hook("whatsapp", c.id, raw, metaSig(waCreds.appSecret, raw));
      expect(res.status).toBe(200);
      const [conv] = await owner<{ id: string; contact_id: string; channel: string; conn_id: string; status: string; handler: string }[]>`
        SELECT id, contact_id, channel, channel_connection_id AS conn_id, status, handler FROM conversations WHERE tenant_id = ${A.tenantId} AND channel_connection_id = ${c.id}`;
      expect(conv).toMatchObject({ channel: "whatsapp", status: "open", handler: "ai", conn_id: c.id });
      const [contact] = await owner<{ name: string; phone: string }[]>`SELECT name, phone FROM contacts WHERE id = ${conv!.contact_id}`;
      expect(contact).toEqual({ name: "Abebe", phone: "+251922222222" });
      const msgs = await owner<{ sender_type: string; content: string }[]>`SELECT sender_type, content FROM messages WHERE conversation_id = ${conv!.id}`;
      expect([...msgs]).toEqual([{ sender_type: "contact", content: "I need pricing" }]);
      expect(await count(owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'ai.respond' AND payload->>'conversationId' = ${conv!.id}`)).toBe(1);
      // replay: same event id => 200 but no new rows/jobs
      expect((await hook("whatsapp", c.id, raw, metaSig(waCreds.appSecret, raw))).status).toBe(200);
      expect(await count(owner`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conv!.id}`)).toBe(1);
      expect(await count(owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'ai.respond' AND payload->>'conversationId' = ${conv!.id}`)).toBe(1);
      // second message from same customer reuses conversation and contact
      const raw2 = waPayload("251922222222", "wamid.ok2", "and availability?");
      await hook("whatsapp", c.id, raw2, metaSig(waCreds.appSecret, raw2));
      expect(await count(owner`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${A.tenantId} AND channel_connection_id = ${c.id}`)).toBe(1);
      expect(await count(owner`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conv!.id}`)).toBe(2);
    });
    test("human-handled conversations still queue ai.respond (runtime skips it unless it is the resume keyword); resolved starts a new one", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const send = async (id: string, text: string) => { const raw = waPayload("251933333333", id, text); return hook("whatsapp", c.id, raw, metaSig(waCreds.appSecret, raw)); };
      await send("w1", "hello");
      const [conv] = await owner<{ id: string }[]>`SELECT id FROM conversations WHERE tenant_id = ${A.tenantId} AND channel_connection_id = ${c.id}`;
      await owner`UPDATE conversations SET handler = 'human' WHERE id = ${conv!.id}`;
      await send("w2", "anyone there?");
      expect(await count(owner`SELECT count(*)::int AS n FROM jobs WHERE name = 'ai.respond' AND payload->>'conversationId' = ${conv!.id}`)).toBe(2);
      await owner`UPDATE conversations SET status = 'resolved' WHERE id = ${conv!.id}`;
      await send("w3", "new question");
      expect(await count(owner`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${A.tenantId} AND channel_connection_id = ${c.id}`)).toBe(2);
    });
    test("identity resolution: existing contact with same phone is linked, no duplicate; name match creates a merge suggestion", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const [existing] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name, phone) VALUES (${A.tenantId}, 'Existing Person', '+251 944 444 444') RETURNING id`;
      const raw = waPayload("251944444444", "wamid.id1", "hi", "Someone Else");
      await hook("whatsapp", c.id, raw, metaSig(waCreds.appSecret, raw));
      const ids = await owner<{ contact_id: string }[]>`SELECT contact_id FROM contact_identities WHERE tenant_id = ${A.tenantId} AND external_id = '251944444444'`;
      expect([...ids]).toEqual([{ contact_id: existing!.id }]);
      expect(await count(owner`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${A.tenantId} AND phone IS NOT NULL AND regexp_replace(phone, '\\D', '', 'g') = '251944444444'`)).toBe(1);
      // different channel, same display name => new contact + suggestion
      await owner`INSERT INTO contacts (tenant_id, name) VALUES (${A.tenantId}, 'Hanna Girma')`;
      const tg = await connect(A, "telegram", { botToken: "id-token-1", webhookSecret: "tg-secret" });
      const upd = JSON.stringify({ update_id: 9001, message: { message_id: 1, date: 1700000000, chat: { id: 4242, type: "private" }, from: { id: 4242, first_name: "hanna", last_name: "girma" }, text: "hi" } });
      expect((await hook("telegram", tg.id, upd, { "x-telegram-bot-api-secret-token": "tg-secret" })).status).toBe(200);
      const sugg = await (await api("GET", "/channels/merge-suggestions", A.h)).json() as any;
      const s = sugg.items.find((i: any) => i.reason === "same_name" && i.primary.name === "Hanna Girma");
      expect(s).toBeDefined();
      expect(s.other.name?.toLowerCase()).toBe("hanna girma");
      expect(((await (await api("GET", "/channels/merge-suggestions", B.h)).json()) as any).items).toEqual([]);
      expect((await api("POST", `/channels/merge-suggestions/${s.id}/dismiss`, B.h)).status).toBe(404);
      expect((await api("POST", `/channels/merge-suggestions/${s.id}/dismiss`, A.h)).status).toBe(200);
      const after = await (await api("GET", "/channels/merge-suggestions", A.h)).json() as any;
      expect(after.items.find((i: any) => i.id === s.id)).toBeUndefined();
    });
    test("disabled connection, wrong channel in path, malformed id => 404; unknown JSON ignored", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const raw = waPayload("251955555555", "wamid.dis", "x");
      expect((await hook("telegram", c.id, raw, metaSig(waCreds.appSecret, raw))).status).toBe(404);
      expect((await hook("whatsapp", "nope", raw, metaSig(waCreds.appSecret, raw))).status).toBe(404);
      expect((await hook("widget", c.id, raw, {})).status).toBe(404);
      const empty = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] });
      expect((await hook("whatsapp", c.id, empty, metaSig(waCreds.appSecret, empty))).status).toBe(200);
      await api("PATCH", `/channels/connections/${c.id}`, A.h, { status: "disabled" });
      expect((await hook("whatsapp", c.id, raw, metaSig(waCreds.appSecret, raw))).status).toBe(404);
    });
    test("tenant isolation: a connection's messages land only in its own tenant", async () => {
      const cb = await connect(B, "whatsapp", { ...waCreds, appSecret: "b-secret" });
      const raw = waPayload("251966666666", "wamid.b1", "hello B");
      expect((await hook("whatsapp", cb.id, raw, metaSig("wa-app-secret", raw))).status).toBe(401); // A's secret is useless on B's connection
      expect((await hook("whatsapp", cb.id, raw, metaSig("b-secret", raw))).status).toBe(200);
      expect(await count(owner`SELECT count(*)::int AS n FROM contact_identities WHERE tenant_id = ${B.tenantId} AND external_id = '251966666666'`)).toBe(1);
      expect(await count(owner`SELECT count(*)::int AS n FROM contact_identities WHERE tenant_id = ${A.tenantId} AND external_id = '251966666666'`)).toBe(0);
    });
    test("RLS: app role sees only own tenant's deliveries/events/suggestions", async () => {
      for (const t of ["channel_webhook_events", "channel_deliveries", "contact_merge_suggestions"]) {
        const rows = await withTenant(db, B.tenantId, (tx) => tx.unsafe(`SELECT tenant_id FROM ${t}`));
        expect(rows.every((r: any) => r.tenantId === B.tenantId)).toBe(true);
        expect((await db.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n).toBe(0); // no GUC => zero rows
      }
    });
  });

  describe("Telegram / Slack webhooks", () => {
    test("telegram: secret header required", async () => {
      const c = await connect(A, "telegram", { botToken: "tg-tok-2", webhookSecret: "s3cret" });
      const upd = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1700000000, chat: { id: 7, type: "private" }, from: { id: 7, first_name: "Z" }, text: "yo" } });
      expect((await hook("telegram", c.id, upd, {})).status).toBe(401);
      expect((await hook("telegram", c.id, upd, { "x-telegram-bot-api-secret-token": "bad" })).status).toBe(401);
      expect((await hook("telegram", c.id, upd, { "x-telegram-bot-api-secret-token": "s3cret" })).status).toBe(200);
      expect(await count(owner`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_connection_id = ${c.id}`)).toBe(1);
    });
    test("slack: signature + timestamp window; url_verification; replay by event id", async () => {
      const secret = "slack-sign-secret";
      const c = await connect(A, "slack", { botToken: "xoxb-test", signingSecret: secret });
      const body = JSON.stringify({ type: "event_callback", event_id: "EvA", event: { type: "message", channel: "D9", channel_type: "im", user: "U9", text: "hello slack", ts: "1700000000.1" } });
      const sig = (ts: string, b: string) => ({ "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex")}` });
      const now = String(Math.floor(Date.now() / 1000));
      const old = String(Math.floor(Date.now() / 1000) - 3600);
      expect((await hook("slack", c.id, body, sig(old, body))).status).toBe(401); // validly signed but stale => replay
      expect((await hook("slack", c.id, body, { ...sig(now, body), "x-slack-signature": "v0=00" })).status).toBe(401);
      const ch = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
      const v = await hook("slack", c.id, ch, sig(now, ch));
      expect(v.status).toBe(200);
      expect(await v.json()).toEqual({ challenge: "chal-123" });
      expect((await hook("slack", c.id, body, sig(now, body))).status).toBe(200);
      expect((await hook("slack", c.id, body, sig(now, body))).status).toBe(200); // Slack retry
      expect(await count(owner`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_connection_id = ${c.id}`)).toBe(1);
    });
    test("messenger + instagram inbound", async () => {
      for (const [channel, object, creds] of [
        ["facebook", "page", { pageAccessToken: "fb-tok-1", pageId: "p1", appSecret: "fb-secret" }],
        ["instagram", "instagram", { accessToken: "ig-tok-1", igUserId: "i1", appSecret: "ig-secret" }],
      ] as const) {
        const c = await connect(A, channel, creds);
        const raw = JSON.stringify({ object, entry: [{ messaging: [{ sender: { id: "u-1" }, timestamp: Date.now(), message: { mid: `mid-${channel}`, text: `hi ${channel}` } }] }] });
        expect((await hook(channel, c.id, raw, metaSig("wrong", raw))).status).toBe(401);
        expect((await hook(channel, c.id, raw, metaSig(creds.appSecret, raw))).status).toBe(200);
        const [m] = await owner<{ content: string }[]>`SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_connection_id = ${c.id}`;
        expect(m!.content).toBe(`hi ${channel}`);
      }
    });
    test("per-connection signature failure rate limit", async () => {
      const c = await connect(A, "telegram", { botToken: "rl-token", webhookSecret: "rl" });
      const upd = JSON.stringify({ update_id: 5 });
      let last = 0;
      for (let i = 0; i < 25; i++) last = (await hook("telegram", c.id, upd, { "x-telegram-bot-api-secret-token": "x" })).status;
      expect(last).toBe(429);
    });
  });

  describe("channel.send job (outbound)", () => {
    async function conversationFor(c: any, from = "251970000001", id = `wamid.${crypto.randomUUID()}`) {
      const raw = waPayload(from, id, "question");
      await hook("whatsapp", c.id, raw, metaSig(waCreds.appSecret, raw));
      const [conv] = await owner<{ id: string }[]>`
        SELECT cv.id FROM conversations cv JOIN contact_identities i ON i.contact_id = cv.contact_id AND i.external_id = ${from}
        WHERE cv.channel_connection_id = ${c.id} ORDER BY cv.created_at DESC LIMIT 1`;
      return conv!.id;
    }
    const runWorker = async () => {
      const handlers = createChannelJobHandlers({ db, registry, decrypt: (e, aad) => decryptCredentials(ENC_KEY, e, aad) });
      const w = startWorker(db, handlers, { pollIntervalMs: 10_000, baseBackoffMs: 10, maxBackoffMs: 20, concurrency: 5 });
      const n = await w.tick();
      await w.stop(1000);
      return n;
    };
    const aiReply = (tenantId: string, convId: string, text: string, sender: "ai" | "human" | "note" | "system" = "ai") =>
      withTenant(db, tenantId, (tx) => tx<{ id: string }[]>`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${tenantId}, ${convId}, ${sender}, ${text}) RETURNING id`).then((r) => r[0]!.id);
    const pendingSend = (convId: string) => owner<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE name = 'channel.send' AND status = 'queued' AND payload->>'messageId' IN (SELECT id::text FROM messages WHERE conversation_id = ${convId})`;

    beforeEach(async () => {
      await owner`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE name = 'channel.send' AND status IN ('queued','running')`;
    });

    test("AI reply is delivered via the channel API; recorded once; notes/system never sent", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const conv = await conversationFor(c);
      respond = () => ({ status: 200, json: { messages: [{ id: "wamid.sent1" }] } });
      const mid = await aiReply(A.tenantId, conv, "Our pricing starts at $10");
      await aiReply(A.tenantId, conv, "internal only", "note");
      await aiReply(A.tenantId, conv, "system event", "system");
      expect((await pendingSend(conv))[0]!.n).toBe(1); // trigger only enqueues ai/human
      expect(await runWorker()).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.path).toBe("/555/messages");
      expect(seen[0]!.headers.authorization).toBe("Bearer wa-token-123456");
      expect(seen[0]!.body).toMatchObject({ to: "251970000001", type: "text", text: { body: "Our pricing starts at $10" } });
      const [d] = await owner<{ status: string; external_message_id: string; used_template: boolean }[]>`SELECT status, external_message_id, used_template FROM channel_deliveries WHERE message_id = ${mid}`;
      expect(d).toEqual({ status: "sent", external_message_id: "wamid.sent1", used_template: false });
      // idempotent: re-enqueue the same message, nothing is sent twice
      await owner`INSERT INTO jobs (tenant_id, name, payload) VALUES (${A.tenantId}, 'channel.send', ${owner.json({ tenantId: A.tenantId, messageId: mid })})`;
      await runWorker();
      expect(seen).toHaveLength(1);
    });
    test("widget conversations are not sent to any channel API", async () => {
      const [ct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${A.tenantId}, 'W') RETURNING id`;
      const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, channel) VALUES (${A.tenantId}, ${ct!.id}, 'widget') RETURNING id`;
      await aiReply(A.tenantId, cv!.id, "hi widget");
      expect((await pendingSend(cv!.id))[0]!.n).toBe(0);
    });
    test("WhatsApp 24h window closed: no API call, delivery failed, visible system message", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const conv = await conversationFor(c, "251970000002");
      await owner`UPDATE conversations SET last_customer_message_at = now() - interval '30 hours' WHERE id = ${conv}`;
      const mid = await aiReply(A.tenantId, conv, "late follow-up");
      await runWorker();
      expect(seen).toHaveLength(0);
      const [d] = await owner<{ status: string; error: string }[]>`SELECT status, error FROM channel_deliveries WHERE message_id = ${mid}`;
      expect(d!.status).toBe("failed");
      expect(d!.error).toContain("24h window");
      const [sys] = await owner<{ content: string; metadata: any }[]>`SELECT content, metadata FROM messages WHERE conversation_id = ${conv} AND sender_type = 'system' ORDER BY created_at DESC LIMIT 1`;
      expect(sys!.metadata.event).toBe("delivery_failed");
      expect(sys!.content).toContain("not delivered");
    });
    test("WhatsApp window closed with fallback template configured uses the template", async () => {
      const c = await connect(A, "whatsapp", { ...waCreds, templateName: "followup", templateLanguage: "en" });
      const conv = await conversationFor(c, "251970000003");
      await owner`UPDATE conversations SET last_customer_message_at = now() - interval '30 hours' WHERE id = ${conv}`;
      const mid = await aiReply(A.tenantId, conv, "template me");
      await runWorker();
      expect(seen[0]!.body.type).toBe("template");
      const [d] = await owner<{ used_template: boolean; status: string }[]>`SELECT used_template, status FROM channel_deliveries WHERE message_id = ${mid}`;
      expect(d).toEqual({ used_template: true, status: "sent" });
    });
    test("transient failure retries (no delivery row, job re-queued); then succeeds", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const conv = await conversationFor(c, "251970000004");
      respond = () => ({ status: 503, json: {} });
      const mid = await aiReply(A.tenantId, conv, "retry me");
      await runWorker();
      expect(await count(owner`SELECT count(*)::int AS n FROM channel_deliveries WHERE message_id = ${mid}`)).toBe(0);
      const [job] = await owner<{ status: string; attempts: number }[]>`SELECT status, attempts FROM jobs WHERE name = 'channel.send' AND payload->>'messageId' = ${mid}`;
      expect(job).toMatchObject({ status: "queued", attempts: 1 });
      respond = () => ({ status: 200, json: { messages: [{ id: "wamid.retry" }] } });
      await owner`UPDATE jobs SET run_at = now() WHERE name = 'channel.send' AND payload->>'messageId' = ${mid}`;
      await runWorker();
      const [d] = await owner<{ status: string; attempts: number }[]>`SELECT status, attempts FROM channel_deliveries WHERE message_id = ${mid}`;
      expect(d).toEqual({ status: "sent", attempts: 2 });
    });
    test("rejected credentials: failure recorded, connection flagged error, no endless retry", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const conv = await conversationFor(c, "251970000005");
      respond = () => ({ status: 401, json: {} });
      const mid = await aiReply(A.tenantId, conv, "x");
      await runWorker();
      const [d] = await owner<{ status: string }[]>`SELECT status FROM channel_deliveries WHERE message_id = ${mid}`;
      expect(d!.status).toBe("failed");
      const [row] = await owner<{ status: string }[]>`SELECT status FROM channel_connections WHERE id = ${c.id}`;
      expect(row!.status).toBe("error");
      const [job] = await owner<{ status: string }[]>`SELECT status FROM jobs WHERE name = 'channel.send' AND payload->>'messageId' = ${mid}`;
      expect(job!.status).toBe("succeeded");
    });
    test("human reply on telegram and slack", async () => {
      const tg = await connect(A, "telegram", { botToken: "out-tg-token", webhookSecret: "ws" });
      const upd = JSON.stringify({ update_id: 321, message: { message_id: 1, date: 1700000000, chat: { id: 31337, type: "private" }, from: { id: 31337, first_name: "Q" }, text: "hi" } });
      await hook("telegram", tg.id, upd, { "x-telegram-bot-api-secret-token": "ws" });
      const [conv] = await owner<{ id: string }[]>`SELECT id FROM conversations WHERE channel_connection_id = ${tg.id}`;
      respond = () => ({ status: 200, json: { ok: true, result: { message_id: 1 } } });
      await withTenant(db, A.tenantId, (tx) => tx`INSERT INTO messages (tenant_id, conversation_id, sender_type, sender_user_id, content) VALUES (${A.tenantId}, ${conv!.id}, 'human', ${A.userId}, 'agent says hi')`);
      await runWorker();
      expect(seen[0]!.path).toContain("sendMessage");
      expect(seen[0]!.body).toEqual({ chat_id: "31337", text: "agent says hi" });
    });
    test("cross-tenant: a job pointing at another tenant's message does nothing", async () => {
      const c = await connect(A, "whatsapp", waCreds);
      const conv = await conversationFor(c, "251970000006");
      const mid = await aiReply(A.tenantId, conv, "mine");
      await owner`UPDATE jobs SET status = 'succeeded' WHERE name = 'channel.send' AND payload->>'messageId' = ${mid}`;
      await owner`INSERT INTO jobs (tenant_id, name, payload) VALUES (${B.tenantId}, 'channel.send', ${owner.json({ tenantId: B.tenantId, messageId: mid })})`;
      await runWorker();
      expect(seen).toHaveLength(0);
      expect(await count(owner`SELECT count(*)::int AS n FROM channel_deliveries WHERE message_id = ${mid}`)).toBe(0);
    });
  });
});
