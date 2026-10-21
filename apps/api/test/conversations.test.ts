import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { originAllowed } from "../src/conversations/origin";
import { decryptCredentials, encryptCredentials } from "../src/conversations/crypto";
import { createRealtime } from "../src/realtime/service";
import { websocket } from "../src/realtime/ws";
import { signAccessToken } from "../src/security";
import { MemoryRateLimiter } from "../src/ratelimit";
import { setupTestDb } from "@yulona/db/testing";
import { SECRET, docsAuth, hasDb, json, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const ORIGIN = "https://site.test";
type Tenant = { tenantId: string; userId: string; token: string; h: Record<string, string> };

describe("origin matching (unit)", () => {
  test("patterns", () => {
    expect(originAllowed("https://a.example.com", ["*.example.com"], true)).toBe(true);
    expect(originAllowed("https://example.com", ["*.example.com"], true)).toBe(false);
    expect(originAllowed("https://example.com", ["example.com"], true)).toBe(true);
    expect(originAllowed("http://example.com", ["https://example.com"], true)).toBe(false);
    expect(originAllowed("https://example.com:8443", ["example.com:8443"], true)).toBe(true);
    expect(originAllowed("https://example.com:9", ["example.com:8443"], true)).toBe(false);
    expect(originAllowed("https://evil-example.com", ["example.com"], true)).toBe(false);
    expect(originAllowed("https://example.com.evil.io", ["example.com"], true)).toBe(false);
    expect(originAllowed(undefined, ["example.com"], true)).toBe(false);
    expect(originAllowed("null", ["example.com"], false)).toBe(false);
    expect(originAllowed("http://localhost:5173", [], false)).toBe(true);
    expect(originAllowed("http://localhost:5173", [], true)).toBe(false);
    expect(originAllowed("https://x.test", [], false)).toBe(false);
  });
  test("credential envelope", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const env = encryptCredentials(key, { token: "abc" }, "conn1");
    expect(env).not.toContain("abc");
    expect(decryptCredentials(key, env, "conn1")).toEqual({ token: "abc" });
    expect(() => decryptCredentials(key, env, "other")).toThrow();
    expect(() => decryptCredentials(Buffer.alloc(32, 8).toString("base64"), env, "conn1")).toThrow();
    expect(() => encryptCredentials("short", {})).toThrow();
  });
});

describe.skipIf(!hasDb)("conversations domain", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let rt: ReturnType<typeof createRealtime>;
  let limiter: MemoryRateLimiter;
  let A: Tenant, B: Tenant;
  let server: ReturnType<typeof Bun.serve>;
  let widget: { id: string; widgetKey: string };

  async function mkTenant(label: string, role: "owner" | "agent" = "owner"): Promise<Tenant> {
    const t = await seedTenantWithUser(owner, label);
    await owner`UPDATE tenants SET plan_key = 'enterprise' WHERE id = ${t.tenantId}`; // plan limits (billing-admin) would cap widgets/conversations on free
    if (role !== "owner") await owner`UPDATE users SET role = ${role} WHERE id = ${t.userId}`;
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { ...t, token, h: { authorization: `Bearer ${token}` } };
  }
  const get = (path: string, h: Record<string, string>) => app.request(`/api/v1${path}`, { headers: h });
  const send = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const pubH = (key: string, extra: Record<string, string> = {}, origin: string | null = ORIGIN) => ({
    "x-widget-key": key, ...(origin ? { origin } : {}), ...extra,
  });
  const pub = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1/public/widget${path}`, {
      method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    const s = await setupTestDb();
    owner = s.owner; db = s.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({}, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; });
    const log = createLogger({ level: "silent" });
    rt = createRealtime({ db, log });
    app = createApp({ cfg, db, limiter, log, realtime: rt });
    A = await mkTenant("A");
    B = await mkTenant("B");
    const res = await send("POST", "/widgets", A.h, {
      name: "Main", allowedDomains: [ORIGIN], config: { welcomeMessage: "Hi there", primaryColor: "#112233" },
      prechat: { enabled: true, intro: "Tell us", fields: [{ name: "email", label: "Email", required: true }] },
    });
    expect(res.status).toBe(201);
    widget = await res.json();
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket: { ...websocket, maxPayloadLength: 8192 } as never });
  });
  afterAll(async () => {
    server?.stop(true);
    await rt.stop();
    limiter.close();
    await db.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });

  async function startConv(extra: Record<string, unknown> = {}, key = widget.widgetKey) {
    const res = await pub("POST", "/conversations", pubH(key), { visitor: { email: "v@example.test", name: "Vi" }, ...extra });
    expect(res.status).toBe(201);
    return (await res.json()) as { sessionToken: string; visitorId: string; conversation: { id: string; status: string; handler: string }; messages: { content: string }[] };
  }
  const sess = (t: string, key = widget.widgetKey) => pubH(key, { authorization: `Bearer ${t}` });

  // ------------------------------------------------------------ widgets
  test("widget CRUD, roles, tenant isolation, key rotation", async () => {
    expect(widget.widgetKey).toMatch(/^wk_/);
    const agent = await mkTenant("Ag", "agent");
    expect((await send("POST", "/widgets", agent.h, { name: "x" })).status).toBe(403);
    expect((await send("POST", "/widgets", A.h, { name: "x", tenantId: B.tenantId })).status).toBe(400); // strict
    expect((await send("POST", "/widgets", A.h, { name: "x", allowedDomains: ["not a domain!"] })).status).toBe(400);
    expect((await get("/widgets", { })).status).toBe(401);
    const list = await (await get("/widgets", A.h)).json() as { items: { id: string }[] };
    expect(list.items.map((w) => w.id)).toContain(widget.id);
    const listB = await (await get("/widgets", B.h)).json() as { items: unknown[] };
    expect(listB.items.length).toBe(0);
    // cross-tenant
    expect((await get(`/widgets/${widget.id}`, B.h)).status).toBe(404);
    expect((await send("PATCH", `/widgets/${widget.id}`, B.h, { name: "hax" })).status).toBe(404);
    expect((await send("DELETE", `/widgets/${widget.id}`, B.h)).status).toBe(404);
    expect((await send("POST", `/widgets/${widget.id}/rotate-key`, B.h)).status).toBe(404);
    expect((await get(`/widgets/${widget.id}/embed`, B.h)).status).toBe(404);
    expect((await get(`/widgets/not-a-uuid`, A.h)).status).toBe(404);
    const embed = await (await get(`/widgets/${widget.id}/embed`, A.h)).json() as { snippet: string };
    expect(embed.snippet).toContain(widget.widgetKey);
    // rotate on a scratch widget
    const w2 = await (await send("POST", "/widgets", A.h, { name: "Scratch", allowedDomains: [ORIGIN] })).json() as { id: string; widgetKey: string };
    const rot = await (await send("POST", `/widgets/${w2.id}/rotate-key`, A.h)).json() as { widgetKey: string };
    expect(rot.widgetKey).not.toBe(w2.widgetKey);
    expect((await pub("GET", "/config", pubH(w2.widgetKey))).status).toBe(403);
    expect((await pub("GET", "/config", pubH(rot.widgetKey))).status).toBe(200);
    expect((await send("DELETE", `/widgets/${w2.id}`, A.h)).status).toBe(200);
    const audits = await owner`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action LIKE 'widget.%'`;
    expect(audits.map((r) => r.action)).toEqual(expect.arrayContaining(["widget.create", "widget.rotate_key", "widget.delete"]));
  });

  // ------------------------------------------------------------ public API gate
  test("origin allowlist, key validation, preflight, disabled widget", async () => {
    expect((await pub("GET", "/config", pubH(widget.widgetKey, {}, null))).status).toBe(403); // no Origin
    expect((await pub("GET", "/config", pubH(widget.widgetKey, {}, "https://evil.test"))).status).toBe(403);
    expect((await pub("GET", "/config", pubH("wk_doesnotexistdoesnotexist"))).status).toBe(403);
    expect((await pub("GET", "/config", { origin: ORIGIN })).status).toBe(403); // no key
    const ok = await pub("GET", "/config", pubH(widget.widgetKey));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = await ok.json() as { config: { primaryColor: string }; schemaVersion: number };
    expect(body.config.primaryColor).toBe("#112233");
    expect(body.schemaVersion).toBe(1);
    expect(JSON.stringify(body)).not.toContain(A.tenantId);
    const bad = await pub("GET", "/config", pubH(widget.widgetKey, {}, "https://evil.test"));
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await pub("OPTIONS", "/messages", { origin: ORIGIN, "access-control-request-method": "POST" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("X-Widget-Key");
    // empty allowlist denies everything outside dev localhost
    const w = await (await send("POST", "/widgets", A.h, { name: "Empty" })).json() as { id: string; widgetKey: string };
    expect((await pub("GET", "/config", pubH(w.widgetKey, {}, "https://site.test"))).status).toBe(403);
    expect((await pub("GET", "/config", pubH(w.widgetKey, {}, "http://localhost:5173"))).status).toBe(200); // test env != prod
    // disabled widget
    await send("PATCH", `/widgets/${w.id}`, A.h, { enabled: false });
    expect((await pub("GET", "/config", pubH(w.widgetKey, {}, "http://localhost:5173"))).status).toBe(403);
    // unknown fields / big bodies
    const big = await pub("POST", "/conversations", pubH(widget.widgetKey), { visitor: { email: "v@example.test", name: "x".repeat(20_000) } });
    expect(big.status).toBe(413);
    const strict = await pub("POST", "/conversations", pubH(widget.widgetKey), { visitor: { email: "v@example.test" }, tenantId: A.tenantId });
    expect(strict.status).toBe(400);
  });

  test("agent greeting is the opening message only when the widget has no welcome message", async () => {
    const mk = async (cfg: object, agentCfg: object, publish?: object) => {
      const [ag] = await owner`INSERT INTO agents (tenant_id, name, config) VALUES (${A.tenantId}, 'G', ${JSON.stringify(agentCfg)}::text::jsonb) RETURNING id`;
      if (publish) {
        await owner`INSERT INTO agent_versions (tenant_id, agent_id, version, config) VALUES (${A.tenantId}, ${ag!.id}, 1, ${JSON.stringify(publish)}::text::jsonb)`;
        await owner`UPDATE agents SET published_version = 1 WHERE id = ${ag!.id}`;
      }
      const w = await (await send("POST", "/widgets", A.h, { name: "G", allowedDomains: [ORIGIN], agentId: ag!.id, config: cfg })).json() as { widgetKey: string };
      return (await startConv({}, w.widgetKey)).messages.map((m) => m.content);
    };
    expect(await mk({}, { greeting: "Draft hello" })).toEqual(["Draft hello"]);
    expect(await mk({}, { greeting: "Draft hello" }, { greeting: "Published hello" })).toEqual(["Published hello"]);
    expect(await mk({ welcomeMessage: "Widget wins" }, { greeting: "Agent greeting" })).toEqual(["Widget wins"]);
    expect(await mk({}, {})).toEqual([]);
  });

  test("prechat required fields enforced", async () => {
    const res = await pub("POST", "/conversations", pubH(widget.widgetKey), { visitor: { name: "NoEmail" } });
    expect(res.status).toBe(400);
  });

  // ------------------------------------------------------------ public conversation flow
  test("start conversation, send (idempotent), history, jobs, ui-events, session scope", async () => {
    const s = await startConv();
    expect(s.conversation.status).toBe("open");
    expect(s.messages.map((m) => m.content)).toEqual(["Hi there"]);

    const h = sess(s.sessionToken);
    const m1 = await pub("POST", "/messages", h, { text: "What are your hours?", clientMessageId: "client-msg-0001" });
    expect(m1.status).toBe(201);
    const msg1 = await m1.json() as { id: string; senderType: string };
    expect(msg1.senderType).toBe("contact");
    const replay = await pub("POST", "/messages", h, { text: "What are your hours?", clientMessageId: "client-msg-0001" });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { id: string }).id).toBe(msg1.id);
    const jobs = await owner`SELECT payload FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'ai.respond' AND payload->>'conversationId' = ${s.conversation.id}`;
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.payload).toEqual({ tenantId: A.tenantId, conversationId: s.conversation.id, messageId: msg1.id });

    // AI reply inserted as the worker would (via owner) shows in history; notes/system do not
    await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, ui)
                VALUES (${A.tenantId}, ${s.conversation.id}, 'ai', 'We open at 9', ${JSON.stringify({ version: 1, components: [{ type: "message", text: "We open at 9" }] })}::jsonb)`;
    await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${A.tenantId}, ${s.conversation.id}, 'note', 'internal secret')`;
    const hist = await (await pub("GET", "/messages", h)).json() as { items: { content: string; senderType: string; ui?: unknown }[]; conversation: { status: string } };
    expect(hist.items.map((m) => m.content)).toEqual(["Hi there", "What are your hours?", "We open at 9"]);
    expect(JSON.stringify(hist)).not.toContain("internal secret");
    expect(hist.items[2]!.ui).toBeTruthy();
    const conv = (await owner`SELECT last_message_preview, last_customer_message_at FROM conversations WHERE id = ${s.conversation.id}`)[0]!;
    expect(conv.last_message_preview).toBe("We open at 9");
    expect(conv.last_customer_message_at).toBeTruthy();

    // ui-event: button on the AI message
    const aiMsg = hist.items[2] as unknown as { id: string };
    const ue = await pub("POST", "/ui-events", h, { type: "button_click", messageId: aiMsg.id, clientMessageId: "client-evt-0001", value: "yes", label: "Yes please" });
    expect(ue.status).toBe(201);
    expect((await ue.json() as { content: string }).content).toBe("Yes please");
    const bad = await pub("POST", "/ui-events", h, { type: "button_click", messageId: crypto.randomUUID(), clientMessageId: "client-evt-0002", value: "x" });
    expect(bad.status).toBe(400);
    const form = await pub("POST", "/ui-events", h, { type: "form_submit", messageId: aiMsg.id, clientMessageId: "client-evt-0003", values: { name: "Zed", phone: "+251911000000" } });
    expect(form.status).toBe(201);
    const ct = (await owner`SELECT name, phone, email FROM contacts WHERE id = (SELECT contact_id FROM conversations WHERE id = ${s.conversation.id})`)[0]!;
    expect(ct.email).toBe("v@example.test");
    expect(ct.name).toBe("Vi"); // fill-only: never overwrites
    expect(ct.phone).toBe("+251911000000");

    // session scope
    expect((await pub("GET", "/messages", pubH(widget.widgetKey))).status).toBe(401); // no token
    expect((await pub("GET", "/messages", pubH(widget.widgetKey, { authorization: "Bearer garbage" }))).status).toBe(401);
    expect((await pub("GET", "/messages", { ...A.h, ...pubH(widget.widgetKey) })).status).toBe(401); // dashboard JWT is not a session
    // tenant B's widget with A's session token
    const wb = await (await send("POST", "/widgets", B.h, { name: "B", allowedDomains: [ORIGIN] })).json() as { widgetKey: string };
    expect((await pub("GET", "/messages", sess(s.sessionToken, wb.widgetKey))).status).toBe(401);
    // session token is not accepted by dashboard endpoints
    expect((await get("/conversations", { authorization: `Bearer ${s.sessionToken}` })).status).toBe(401);
    // refresh
    const rf = await pub("POST", "/session/refresh", h, undefined);
    expect(rf.status).toBe(200);
    expect(((await rf.json()) as { sessionToken: string }).sessionToken).toBeTruthy();
    // revoked session
    await owner`UPDATE widget_sessions SET revoked_at = now() WHERE conversation_id = ${s.conversation.id}`;
    expect((await pub("GET", "/messages", h)).status).toBe(401);
  });

  test("visitorId links conversations to one contact; rate limiting", async () => {
    const a = await startConv();
    const b = await startConv({ visitorId: a.visitorId });
    const rows = await owner`SELECT DISTINCT contact_id FROM conversations WHERE id IN (${a.conversation.id}, ${b.conversation.id})`;
    expect(rows.length).toBe(1);
    const h = sess(a.sessionToken);
    let limited = 0;
    for (let i = 0; i < 65; i++) {
      const r = await pub("POST", "/typing", h, { typing: true });
      if (r.status === 429) { limited++; expect(r.headers.get("retry-after")).toBeTruthy(); }
    }
    expect(limited).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------ dashboard
  test("conversations: list/filter/search, messages, reply+takeover, note, return-to-ai, patch", async () => {
    const s = await startConv();
    const id = s.conversation.id;
    await pub("POST", "/messages", sess(s.sessionToken), { text: "needle-xyz please", clientMessageId: "client-msg-0002" });

    const all = await (await get("/conversations?limit=2", A.h)).json() as { items: { id: string }[]; nextCursor: string | null };
    expect(all.items.length).toBe(2);
    expect(all.nextCursor).toBeTruthy();
    const next = await (await get(`/conversations?limit=2&cursor=${all.nextCursor}`, A.h)).json() as { items: { id: string }[] };
    expect(next.items.every((c) => !all.items.some((x) => x.id === c.id))).toBe(true);
    expect((await get("/conversations?cursor=bogus", A.h)).status).toBe(400);
    expect((await get("/conversations?tenantId=x", A.h)).status).toBe(400);

    const found = await (await get("/conversations?q=needle-xyz", A.h)).json() as { items: { id: string; contact: { email: string } }[] };
    expect(found.items.map((c) => c.id)).toEqual([id]);
    expect(found.items[0]!.contact.email).toBe("v@example.test");
    expect((await (await get("/conversations?q=needle-xyz", B.h)).json() as { items: unknown[] }).items.length).toBe(0);
    expect((await (await get("/conversations?status=pending_human&q=needle-xyz", A.h)).json() as { items: unknown[] }).items.length).toBe(0);

    const detail = await (await get(`/conversations/${id}`, A.h)).json() as { handler: string };
    expect(detail.handler).toBe("ai");

    // internal note: visible to agents, never to visitors; does not enqueue AI
    const note = await send("POST", `/conversations/${id}/messages`, A.h, { text: "careful with this one", kind: "note" });
    expect(note.status).toBe(201);
    expect(((await (await get(`/conversations/${id}`, A.h)).json()) as { handler: string }).handler).toBe("ai");
    const msgs = await (await get(`/conversations/${id}/messages?limit=2`, A.h)).json() as { items: { content: string; senderType: string }[]; nextCursor: string | null };
    expect(msgs.items.length).toBe(2);
    expect(msgs.items.map((m) => m.senderType)).toContain("note");
    expect(msgs.nextCursor).toBeTruthy();
    const older = await (await get(`/conversations/${id}/messages?before=${msgs.nextCursor}`, A.h)).json() as { items: unknown[] };
    expect(older.items.length).toBeGreaterThan(0);

    // reply => takeover, no further AI jobs
    const jobsBefore = (await owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND payload->>'conversationId' = ${id}`)[0]!.n;
    const reply = await send("POST", `/conversations/${id}/messages`, A.h, { text: "Hello from a human" });
    expect(reply.status).toBe(201);
    const afterReply = await (await get(`/conversations/${id}`, A.h)).json() as { handler: string; assignedUserId: string; status: string };
    expect(afterReply).toMatchObject({ handler: "human", assignedUserId: A.userId, status: "open" });
    await pub("POST", "/messages", sess(s.sessionToken), { text: "thanks", clientMessageId: "client-msg-0003" });
    const jobsAfter = (await owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND payload->>'conversationId' = ${id}`)[0]!.n;
    // a job is queued even while a person handles it (the runtime skips it unless it is the resume keyword)
    expect(jobsAfter).toBe(jobsBefore + 1);
    const visitorView = await (await pub("GET", "/messages", sess(s.sessionToken))).json() as { items: { content: string; senderType: string }[] };
    expect(visitorView.items.some((m) => m.content === "Hello from a human" && m.senderType === "human")).toBe(true);
    expect(JSON.stringify(visitorView)).not.toContain("careful with this one");
    expect(JSON.stringify(visitorView)).not.toContain("took over");

    // another agent cannot steal an assigned conversation, an admin can
    const other = await mkTenantInSame(A, "agent");
    expect((await send("POST", `/conversations/${id}/takeover`, other.h)).status).toBe(409);
    expect((await send("POST", `/conversations/${id}/takeover`, A.h)).status).toBe(200);

    // return to AI
    const back = await (await send("POST", `/conversations/${id}/return-to-ai`, A.h)).json() as { handler: string; assignedUserId: string | null; status: string };
    expect(back).toMatchObject({ handler: "ai", assignedUserId: null, status: "open" });
    await pub("POST", "/messages", sess(s.sessionToken), { text: "again", clientMessageId: "client-msg-0004" });
    const jobsFinal = (await owner`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${A.tenantId} AND payload->>'conversationId' = ${id}`)[0]!.n;
    expect(jobsFinal).toBe(jobsAfter + 1);

    // patch + resolve + visitor message reopens
    expect((await send("PATCH", `/conversations/${id}`, A.h, { status: "resolved" })).status).toBe(200);
    expect((await send("PATCH", `/conversations/${id}`, A.h, {})).status).toBe(400);
    expect((await send("PATCH", `/conversations/${id}`, A.h, { assignedUserId: B.userId })).status).toBe(400); // other tenant's user
    await pub("POST", "/messages", sess(s.sessionToken), { text: "reopen me", clientMessageId: "client-msg-0005" });
    expect(((await (await get(`/conversations/${id}`, A.h)).json()) as { status: string }).status).toBe("open");

    // pending_human (set by ai-runtime) leaves the AI stopped and clears on human reply
    await owner`UPDATE conversations SET status = 'pending_human' WHERE id = ${id}`;
    const pend = await (await get("/conversations?status=pending_human", A.h)).json() as { items: { id: string }[] };
    expect(pend.items.map((c) => c.id)).toContain(id);

    // audit
    const au = await owner`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND resource_id = ${id}`;
    expect(au.map((r) => r.action)).toEqual(expect.arrayContaining(["conversation.takeover", "conversation.return_to_ai", "conversation.update"]));

    // ---- cross-tenant: every endpoint 404s for tenant B
    expect((await get(`/conversations/${id}`, B.h)).status).toBe(404);
    expect((await get(`/conversations/${id}/messages`, B.h)).status).toBe(404);
    expect((await send("POST", `/conversations/${id}/messages`, B.h, { text: "x" })).status).toBe(404);
    expect((await send("POST", `/conversations/${id}/takeover`, B.h)).status).toBe(404);
    expect((await send("POST", `/conversations/${id}/return-to-ai`, B.h)).status).toBe(404);
    expect((await send("PATCH", `/conversations/${id}`, B.h, { status: "resolved" })).status).toBe(404);
    expect((await get("/conversations", {})).status).toBe(401);
  });

  async function mkTenantInSame(t: Tenant, role: "agent" | "admin"): Promise<Tenant> {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t.tenantId}, ${`x-${crypto.randomUUID()}@example.test`}, 'Other', ${role}, 'x') RETURNING id`;
    const token = await signAccessToken(SECRET, { userId: u!.id, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { tenantId: t.tenantId, userId: u!.id, token, h: { authorization: `Bearer ${token}` } };
  }

  test("contacts: CRUD, attributes, timeline, merge, delete guard, isolation", async () => {
    const c1 = await (await send("POST", "/contacts", A.h, { name: "Primary", customAttributes: { plan: "pro", seats: 3 } })).json() as { id: string };
    const c2 = await (await send("POST", "/contacts", A.h, { name: "Dup", email: "dup@example.test", phone: "+15550100", customAttributes: { plan: "free", city: "Addis" } })).json() as { id: string };
    expect((await send("POST", "/contacts", A.h, { email: "nope" })).status).toBe(400);
    expect((await send("POST", "/contacts", A.h, { customAttributes: { "bad key": "x" } })).status).toBe(400);
    expect((await send("POST", "/contacts", A.h, { tenantId: B.tenantId })).status).toBe(400);

    const patched = await (await send("PATCH", `/contacts/${c1.id}`, A.h, { customAttributes: { seats: null, tier: "gold" }, phone: "+15550111" })).json() as { customAttributes: Record<string, unknown>; phone: string };
    expect(patched.customAttributes).toEqual({ plan: "pro", tier: "gold" });
    expect(patched.phone).toBe("+15550111");

    // conversations for c2 across two "channels" (second is inserted directly as a future adapter would)
    const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, channel) VALUES (${A.tenantId}, ${c2.id}, 'whatsapp') RETURNING id`;
    await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${A.tenantId}, ${cv!.id}, 'contact', 'hello via whatsapp')`;
    await owner`INSERT INTO contact_identities (tenant_id, contact_id, channel, external_id) VALUES (${A.tenantId}, ${c2.id}, 'whatsapp', ${"+15550100-" + c2.id})`;
    expect((await send("DELETE", `/contacts/${c2.id}`, A.h)).status).toBe(409);

    // cross-tenant
    for (const [m, p, b] of [["GET", `/contacts/${c1.id}`], ["PATCH", `/contacts/${c1.id}`, { name: "h" }], ["DELETE", `/contacts/${c1.id}`], ["GET", `/contacts/${c1.id}/timeline`], ["POST", `/contacts/${c1.id}/merge`, { sourceContactId: c2.id }], ["POST", `/contacts/${c2.id}/merge`, { sourceContactId: c1.id }]] as const) {
      expect((await send(m, p, B.h, b)).status).toBe(404);
    }
    const bContact = await (await send("POST", "/contacts", B.h, { name: "B's" })).json() as { id: string };
    expect((await send("POST", `/contacts/${c1.id}/merge`, A.h, { sourceContactId: bContact.id })).status).toBe(404);
    expect((await send("POST", `/contacts/${c1.id}/merge`, A.h, { sourceContactId: c1.id })).status).toBe(400);

    const merged = await (await send("POST", `/contacts/${c1.id}/merge`, A.h, { sourceContactId: c2.id })).json() as { name: string; email: string; customAttributes: Record<string, unknown>; identities: { channel: string }[] };
    expect(merged.name).toBe("Primary");
    expect(merged.email).toBe("dup@example.test");
    expect(merged.customAttributes).toEqual({ plan: "pro", tier: "gold", city: "Addis" });
    expect(merged.identities.map((i) => i.channel)).toContain("whatsapp");
    expect((await get(`/contacts/${c2.id}`, A.h)).status).toBe(404);
    expect((await send("POST", `/contacts/${c1.id}/merge`, A.h, { sourceContactId: c2.id })).status).toBe(409);
    const tl = await (await get(`/contacts/${c1.id}/timeline`, A.h)).json() as { items: { type: string; channel: string; message?: { content: string } }[] };
    expect(tl.items.some((i) => i.type === "message" && i.message?.content === "hello via whatsapp" && i.channel === "whatsapp")).toBe(true);
    expect(tl.items.some((i) => i.type === "conversation_started")).toBe(true);
    const list = await (await get("/contacts?q=Primary", A.h)).json() as { items: { id: string }[] };
    expect(list.items.map((c) => c.id)).toContain(c1.id);
    const all = await (await get("/contacts?limit=1", A.h)).json() as { items: unknown[]; nextCursor: string | null };
    expect(all.items.length).toBe(1);
    expect(all.nextCursor).toBeTruthy();
    expect(((await (await get("/contacts", B.h)).json()) as { items: { id: string }[] }).items.map((c) => c.id)).not.toContain(c1.id);

    const lone = await (await send("POST", "/contacts", A.h, { name: "Lone" })).json() as { id: string };
    expect((await send("DELETE", `/contacts/${lone.id}`, A.h)).status).toBe(200);
  });


  test("RLS: app role sees nothing without a tenant GUC and cannot cross-write; OpenAPI lists the routes", async () => {
    for (const t of ["contacts", "contact_identities", "widgets", "conversations", "messages", "widget_sessions", "contact_merges", "channel_connections"]) {
      const rows = await db.unsafe(`SELECT 1 FROM ${t} LIMIT 1`);
      expect(rows.length).toBe(0);
    }
    await expect(db.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant_id', ${B.tenantId}, true)`;
      await tx`INSERT INTO contacts (tenant_id, name) VALUES (${A.tenantId}, 'x')`;
    })).rejects.toThrow();
    const doc = await (await app.request("/api/v1/openapi.json", { headers: docsAuth() })).json() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/v1/conversations", "/api/v1/contacts/{id}/merge", "/api/v1/public/widget/messages"]));
  });

  // ------------------------------------------------------------ realtime
  function ws(url: string, origin?: string) {
    const sock = new WebSocket(url, (origin ? { headers: { Origin: origin } } : undefined) as never);
    const events: any[] = [];
    let closed: { code: number } | null = null;
    sock.onmessage = (e) => events.push(JSON.parse(String(e.data)));
    sock.onclose = (e) => { closed = { code: e.code }; };
    const opened = new Promise<void>((res, rej) => { sock.onopen = () => res(); sock.onerror = () => rej(new Error("ws error")); });
    const waitFor = async (pred: (e: any) => boolean, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await Bun.sleep(25);
      }
      throw new Error("timeout waiting for event; got " + JSON.stringify(events));
    };
    const waitClose = async (ms = 4000) => {
      const end = Date.now() + ms;
      while (!closed && Date.now() < end) await Bun.sleep(25);
      return closed;
    };
    return { sock, events, opened, waitFor, waitClose };
  }

  test("websocket: first-frame auth, fan-out, visibility, tenant isolation, SSE", async () => {
    const base = `ws://localhost:${server.port}`;
    // unauthenticated / bad token => closed 4401
    const bad = ws(`${base}/api/v1/realtime/ws`);
    await bad.opened;
    bad.sock.send(JSON.stringify({ type: "auth", token: "nope" }));
    expect((await bad.waitClose())?.code).toBe(4401);
    const noAuth = ws(`${base}/api/v1/realtime/ws`);
    await noAuth.opened;
    noAuth.sock.send(JSON.stringify({ type: "ping" }));
    expect((await noAuth.waitClose())?.code).toBe(4401);
    // token in URL is not a thing
    const urlTok = ws(`${base}/api/v1/realtime/ws?token=${A.token}`);
    await urlTok.opened;
    urlTok.sock.send(JSON.stringify({ type: "ping" }));
    expect((await urlTok.waitClose())?.code).toBe(4401);
    // disallowed Origin on the dashboard socket
    const evilOrigin = ws(`${base}/api/v1/realtime/ws`, "https://evil.test");
    await expect(evilOrigin.opened).rejects.toThrow();
    // visitor socket with a wrong Origin is refused at upgrade
    const s = await startConv();
    const evilV = ws(`${base}/api/v1/public/widget/ws?key=${widget.widgetKey}`, "https://evil.test");
    await expect(evilV.opened).rejects.toThrow();

    const agentA = ws(`${base}/api/v1/realtime/ws`);
    const agentB = ws(`${base}/api/v1/realtime/ws`);
    const visitor = ws(`${base}/api/v1/public/widget/ws?key=${widget.widgetKey}`, ORIGIN);
    await Promise.all([agentA.opened, agentB.opened, visitor.opened]);
    agentA.sock.send(JSON.stringify({ type: "auth", token: A.token }));
    agentB.sock.send(JSON.stringify({ type: "auth", token: B.token }));
    visitor.sock.send(JSON.stringify({ type: "auth", token: s.sessionToken }));
    await Promise.all([agentA, agentB, visitor].map((x) => x.waitFor((e) => e.type === "ready")));
    expect(visitor.events.find((e) => e.type === "ready").kind).toBe("visitor");

    // visitor -> agent A (not B)
    await pub("POST", "/messages", sess(s.sessionToken), { text: "live hello", clientMessageId: "client-msg-0010" });
    const got = await agentA.waitFor((e) => e.type === "message.created" && e.message.content === "live hello");
    expect(got.conversationId).toBe(s.conversation.id);
    await visitor.waitFor((e) => e.type === "message.created" && e.message.content === "live hello");

    // agent note => agent only; reply => visitor too
    await send("POST", `/conversations/${s.conversation.id}/messages`, A.h, { text: "secret note", kind: "note" });
    await agentA.waitFor((e) => e.type === "message.created" && e.message.content === "secret note");
    await send("POST", `/conversations/${s.conversation.id}/messages`, A.h, { text: "agent reply" });
    await visitor.waitFor((e) => e.type === "message.created" && e.message.content === "agent reply");
    await visitor.waitFor((e) => e.type === "conversation.updated" && e.conversation.handler === "human");
    await agentA.waitFor((e) => e.type === "conversation.updated" && e.conversation.id === s.conversation.id);
    expect(visitor.events.some((e) => JSON.stringify(e).includes("secret note"))).toBe(false);
    expect(visitor.events.some((e) => JSON.stringify(e).includes("took over"))).toBe(false);

    // typing both ways
    agentA.sock.send(JSON.stringify({ type: "typing", conversationId: s.conversation.id, typing: true }));
    await visitor.waitFor((e) => e.type === "typing" && e.from === "human");
    visitor.sock.send(JSON.stringify({ type: "typing", typing: true }));
    await agentA.waitFor((e) => e.type === "typing" && e.from === "contact");

    // tenant B's socket saw nothing about A
    await Bun.sleep(150);
    expect(agentB.events.filter((e) => e.type !== "ready" && e.type !== "presence").length).toBe(0);
    expect(JSON.stringify(agentB.events)).not.toContain(s.conversation.id);

    // oversized frame closes the socket
    agentB.sock.send("x".repeat(5000));
    expect((await agentB.waitClose())?.code).toBeOneOf([1009, 1006]);

    // SSE fallback
    const res = await fetch(`http://localhost:${server.port}/api/v1/public/widget/stream`, { headers: sess(s.sessionToken) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      const end = Date.now() + 4000;
      while (!text.includes(needle) && Date.now() < end) {
        const r = await Promise.race([reader.read(), Bun.sleep(300).then(() => null)]);
        if (r && !r.done) text += dec.decode(r.value);
      }
      expect(text).toContain(needle);
    };
    await readUntil("event: ready");
    await send("POST", `/conversations/${s.conversation.id}/messages`, A.h, { text: "via sse" });
    await readUntil("via sse");
    await reader.cancel();

    for (const x of [agentA, agentB, visitor]) x.sock.close();
  });
});
