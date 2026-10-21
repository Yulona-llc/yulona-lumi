import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { dispatchNotificationEmails, executeCalendarTool, GoogleCalendarClient, loadTenantCalendar, runSlaScan, signState, signWebhook } from "@yulona/ops";
import { MockEmailProvider } from "@yulona/providers";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

// ---------------------------------------------------------------- DB-backed
const KEY = Buffer.alloc(32, 9).toString("base64");
type Tenant = { tenantId: string; userId: string; token: string; h: Record<string, string> };

describe.skipIf(!hasDb)("ops domain", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  let A: Tenant, B: Tenant, AgentA: Tenant, ViewerA: Tenant;

  // ---- mock Google ----
  const g = { busy: [] as { start: string; end: string }[], eventMode: "ok" as "ok" | "500" | "hang", events: new Map<string, unknown>(), deleted: [] as string[], tokenCalls: 0, eventCalls: 0, expireIn: 3600 };
  let google: ReturnType<typeof Bun.serve>;
  const googleBase = () => `http://localhost:${google.port}`;

  async function mkTenant(label: string, role: "owner" | "agent" | "viewer" = "owner", tenantId?: string): Promise<Tenant> {
    let t: { tenantId: string; userId: string };
    if (tenantId) {
      const [u] = await owner<{ id: string }[]>`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tenantId}, ${`${label}-${crypto.randomUUID().slice(0, 6)}@example.test`}, ${label}, ${role}, 'x') RETURNING id`;
      t = { tenantId, userId: u!.id };
    } else {
      t = await seedTenantWithUser(owner, label);
      if (role !== "owner") await owner`UPDATE users SET role = ${role} WHERE id = ${t.userId}`;
    }
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { ...t, token, h: { authorization: `Bearer ${token}` } };
  }
  const call = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = async (res: Response) => (await res.json()) as any;
  const ok = async (method: string, path: string, h: Record<string, string>, body?: unknown, status = 200) => {
    const res = await call(method, path, h, body);
    if (res.status !== status) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : await res.json().catch(() => null) as any;
  };

  async function mkContactAndConv(t: Tenant, extra: { handler?: string; status?: string } = {}) {
    const [ct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name, email) VALUES (${t.tenantId}, 'Cora Contact', ${`cora-${crypto.randomUUID().slice(0, 6)}@example.test`}) RETURNING id`;
    const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, status, handler) VALUES (${t.tenantId}, ${ct!.id}, ${extra.status ?? "open"}, ${extra.handler ?? "ai"}) RETURNING id`;
    return { contactId: ct!.id, conversationId: cv!.id };
  }

  beforeAll(async () => {
    google = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/token") {
          g.tokenCalls++;
          return Response.json({ access_token: `at-${g.tokenCalls}`, refresh_token: "rt-secret-xyz", expires_in: g.expireIn });
        }
        if (u.pathname === "/calendar/v3/calendars/primary" && req.method === "GET") return Response.json({ id: "owner@cal.test" });
        if (u.pathname === "/calendar/v3/freeBusy") return Response.json({ calendars: { primary: { busy: g.busy } } });
        if (u.pathname === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
          g.eventCalls++;
          if (g.eventMode === "hang") return new Promise<Response>(() => {});
          if (g.eventMode === "500") return new Response("nope", { status: 500 });
          const id = `ev-${g.events.size + 1}`;
          g.events.set(id, await req.json());
          return Response.json({ id, htmlLink: `https://cal.test/${id}` });
        }
        const del = /^\/calendar\/v3\/calendars\/primary\/events\/(.+)$/.exec(u.pathname);
        if (del && req.method === "DELETE") { g.deleted.push(del[1]!); return new Response(null, { status: 204 }); }
        return new Response("not found", { status: 404 });
      },
    });
    const s = await setupTestDb();
    owner = s.owner; db = s.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({}, (c) => {
      c.rateLimits.global = { limit: 1e6, windowMs: 60_000 };
      c.encryptionKey = KEY;
      c.publicApiUrl = "https://api.example.test";
      c.appUrl = "https://app.example.test";
    });
    app = createApp({
      cfg, db, limiter, log: createLogger({ level: "silent" }),
      ops: {
        google: { clientId: "cid", clientSecret: "csecret", redirectUri: "https://api.example.test/api/v1/calendar/google/callback", authUrl: `${googleBase()}/auth`, tokenUrl: `${googleBase()}/token`, apiBase: `${googleBase()}/calendar/v3`, revokeUrl: `${googleBase()}/revoke` },
        calendarRetry: { attempts: 3, baseMs: 1, timeoutMs: 300 },
      },
    });
    A = await mkTenant("A");
    B = await mkTenant("B");
    AgentA = await mkTenant("agentA", "agent", A.tenantId);
    ViewerA = await mkTenant("viewerA", "viewer", A.tenantId);
  });
  afterAll(async () => {
    google?.stop(true);
    limiter.close();
    await db.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });

  // ------------------------------------------------------------ tickets
  test("tickets: create/list/filter/patch/events/bulk/board + isolation + roles", async () => {
    const { contactId, conversationId } = await mkContactAndConv(A);
    const t1 = await ok("POST", "/tickets", A.h, { title: "Refund request", priority: "high", contactId, conversationId, assigneeUserId: AgentA.userId }, 201);
    expect(t1.number).toBe(1);
    expect(t1.status).toBe("open");
    const slaMs = new Date(t1.dueAt).getTime() - Date.now();
    expect(slaMs).toBeGreaterThan(239 * 60_000 - 5000);
    expect(slaMs).toBeLessThan(240 * 60_000 + 5000);
    const t2 = await ok("POST", "/tickets", AgentA.h, { title: "Login broken" }, 201);
    expect(t2.number).toBe(2);
    expect(t2.assigneeUserId).toBeNull();

    // assignee got a notification (email pending)
    const n = await ok("GET", "/notifications?unread=true", AgentA.h);
    expect(n.items.some((x: any) => x.type === "ticket.assigned" && x.data.ticketId === t1.id)).toBe(true);
    expect(n.unreadCount).toBeGreaterThanOrEqual(1);

    expect((await ok("GET", "/tickets?priority=high", A.h)).items.map((x: any) => x.id)).toEqual([t1.id]);
    expect((await ok("GET", "/tickets?assignee=unassigned", A.h)).items.map((x: any) => x.id)).toEqual([t2.id]);
    expect((await ok("GET", "/tickets?assignee=me", AgentA.h)).items.map((x: any) => x.id)).toEqual([t1.id]);
    expect((await ok("GET", `/tickets?conversationId=${conversationId}`, A.h)).items).toHaveLength(1);
    expect((await ok("GET", "/tickets?q=login", A.h)).items.map((x: any) => x.id)).toEqual([t2.id]);
    expect((await ok("GET", "/tickets?q=%232", A.h)).items.map((x: any) => x.id)).toEqual([t2.id]);
    const page1 = await ok("GET", "/tickets?limit=1", A.h);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await ok("GET", `/tickets?limit=1&cursor=${page1.nextCursor}`, A.h);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect((await call("GET", "/tickets?bogus=1", A.h)).status).toBe(400); // unknown query params rejected
    expect((await call("GET", "/tickets?limit=0", A.h)).status).toBe(400);

    // patch: status + priority recompute + events
    const p = await ok("PATCH", `/tickets/${t1.id}`, AgentA.h, { status: "in_progress", priority: "urgent" });
    expect(p.status).toBe("in_progress");
    expect(new Date(p.dueAt).getTime() - new Date(p.createdAt).getTime()).toBe(60 * 60_000);
    const done = await ok("PATCH", `/tickets/${t1.id}`, AgentA.h, { status: "resolved" });
    expect(done.resolvedAt).toBeTruthy();
    const reopened = await ok("PATCH", `/tickets/${t1.id}`, AgentA.h, { status: "open" });
    expect(reopened.resolvedAt).toBeNull();
    const ev = await ok("GET", `/tickets/${t1.id}/events`, A.h);
    expect(ev.items.map((e: any) => e.type)).toEqual(expect.arrayContaining(["created", "status_changed", "priority_changed"]));
    expect(ev.items[0].type).toBe("created");
    const c1 = await ok("POST", `/tickets/${t1.id}/comments`, AgentA.h, { text: "Called customer" }, 201);
    expect(c1.type).toBe("comment");

    // validation: strict bodies, bad reference
    expect((await call("PATCH", `/tickets/${t1.id}`, A.h, { status: "nope" })).status).toBe(400);
    expect((await call("PATCH", `/tickets/${t1.id}`, A.h, { tenantId: B.tenantId })).status).toBe(400);
    expect((await call("POST", "/tickets", A.h, { title: "x", assigneeUserId: B.userId })).status).toBe(400);
    expect((await call("POST", "/tickets", A.h, { title: "x", contactId: crypto.randomUUID() })).status).toBe(400);

    // roles
    expect((await call("POST", "/tickets", ViewerA.h, { title: "nope" })).status).toBe(403);
    expect((await call("GET", "/tickets", ViewerA.h)).status).toBe(200);
    expect((await call("GET", "/tickets", {})).status).toBe(401);
    expect((await call("DELETE", `/tickets/${t2.id}`, AgentA.h)).status).toBe(403);

    // cross-tenant
    expect((await call("GET", `/tickets/${t1.id}`, B.h)).status).toBe(404);
    expect((await call("PATCH", `/tickets/${t1.id}`, B.h, { title: "hax" })).status).toBe(404);
    expect((await call("GET", `/tickets/${t1.id}/events`, B.h)).status).toBe(404);
    expect((await call("POST", `/tickets/${t1.id}/comments`, B.h, { text: "x" })).status).toBe(404);
    expect((await ok("GET", "/tickets", B.h)).items).toHaveLength(0);
    expect((await call("GET", "/tickets/not-a-uuid", A.h)).status).toBe(404);

    // bulk
    const t3 = await ok("POST", "/tickets", A.h, { title: "Bulk me" }, 201);
    const bulk = await ok("POST", "/tickets/bulk", AgentA.h, { ids: [t2.id, t3.id, crypto.randomUUID()], action: "set_status", value: "waiting" });
    expect(bulk).toEqual({ updated: 2, skipped: 1 });
    expect((await ok("GET", `/tickets/${t2.id}/events`, A.h)).items.some((e: any) => e.type === "status_changed" && e.data.bulk)).toBe(true);
    expect(await ok("POST", "/tickets/bulk", AgentA.h, { ids: [t2.id], action: "assign", value: AgentA.userId })).toEqual({ updated: 1, skipped: 0 });
    expect(await ok("POST", "/tickets/bulk", AgentA.h, { ids: [t2.id], action: "set_priority", value: "low" })).toEqual({ updated: 1, skipped: 0 });
    expect((await call("POST", "/tickets/bulk", AgentA.h, { ids: [t2.id], action: "set_status", value: "bogus" })).status).toBe(400);
    expect((await call("POST", "/tickets/bulk", AgentA.h, { ids: [t2.id], action: "delete" })).status).toBe(403);
    expect((await call("POST", "/tickets/bulk", B.h, { ids: [t2.id], action: "set_status", value: "closed" })).status).toBe(200); // B sees none of A's tickets
    expect((await ok("GET", `/tickets/${t2.id}`, A.h)).status).toBe("waiting");
    expect(await ok("POST", "/tickets/bulk", A.h, { ids: [t3.id], action: "delete" })).toEqual({ updated: 1, skipped: 0 });

    const board = await ok("GET", "/tickets/board", A.h);
    expect(board.totals.open).toBe(1);
    expect(board.totals.waiting).toBe(1);
    expect(board.columns.waiting[0].id).toBe(t2.id);
    expect(Object.keys(board.columns)).toEqual(["open", "in_progress", "waiting", "resolved", "closed"]);
  });

  test("tickets: SLA breach scan marks breached, writes event + notification, stops after resolve", async () => {
    const t = await ok("POST", "/tickets", A.h, { title: "SLA victim", priority: "low" }, 201);
    await owner`UPDATE tickets SET due_at = now() - interval '5 minutes' WHERE id = ${t.id}`;
    const resolved = await ok("POST", "/tickets", A.h, { title: "Already done", priority: "low" }, 201);
    await owner`UPDATE tickets SET due_at = now() - interval '5 minutes', status = 'resolved' WHERE id = ${resolved.id}`;
    expect(await runSlaScan(db)).toBeGreaterThanOrEqual(1);
    const after = await ok("GET", `/tickets/${t.id}`, A.h);
    expect(after.slaBreachedAt).toBeTruthy();
    expect((await ok("GET", `/tickets/${resolved.id}`, A.h)).slaBreachedAt).toBeNull();
    expect((await ok("GET", `/tickets/${t.id}/events`, A.h)).items.some((e: any) => e.type === "sla_breached")).toBe(true);
    const notes = await ok("GET", "/notifications", A.h);
    expect(notes.items.some((n: any) => n.type === "ticket.sla_breached" && n.data.ticketId === t.id)).toBe(true);
    // idempotent
    await runSlaScan(db);
    const events = await ok("GET", `/tickets/${t.id}/events`, A.h);
    expect(events.items.filter((e: any) => e.type === "sla_breached")).toHaveLength(1);
    expect((await ok("GET", "/tickets?slaBreached=true", A.h)).items.some((x: any) => x.id === t.id)).toBe(true);
    // B never sees A's notifications
    expect((await ok("GET", "/notifications", B.h)).items).toHaveLength(0);
  });

  // ------------------------------------------------------------ transactions
  test("transactions: CRUD, filters, summary, CSV export, roles, isolation", async () => {
    const { contactId } = await mkContactAndConv(A);
    const a = await ok("POST", "/transactions", A.h, { amountCents: 12_500, currency: "usd", description: "Pro plan", externalId: "INV-1", contactId }, 201);
    expect(a.currency).toBe("USD");
    expect(a.source).toBe("manual");
    await ok("POST", "/transactions", A.h, { amountCents: 500, currency: "USD", status: "pending", description: "=HYPERLINK(\"http://evil\")" }, 201);
    await ok("POST", "/transactions", A.h, { amountCents: -2_000, currency: "USD", status: "refunded" }, 201);
    expect((await call("POST", "/transactions", A.h, { amountCents: 1, currency: "USD", externalId: "INV-1" })).status).toBe(409);
    expect((await call("POST", "/transactions", A.h, { amountCents: 1.5, currency: "USD" })).status).toBe(400);
    expect((await call("POST", "/transactions", A.h, { amountCents: 1, currency: "DOLLARS" })).status).toBe(400);
    expect((await call("POST", "/transactions", ViewerA.h, { amountCents: 1, currency: "USD" })).status).toBe(403);
    expect((await call("GET", "/transactions", ViewerA.h)).status).toBe(403);

    const all = await ok("GET", "/transactions", A.h);
    expect(all.items).toHaveLength(3);
    expect(all.summary.count).toBe(3);
    expect(all.summary.totalCents).toBe(12_500); // completed only
    expect((await ok("GET", "/transactions?status=pending,refunded", A.h)).items).toHaveLength(2);
    expect((await ok("GET", `/transactions?contactId=${contactId}`, A.h)).items).toHaveLength(1);
    expect((await ok("GET", "/transactions?minAmountCents=1000", A.h)).items).toHaveLength(1);
    expect((await ok("GET", "/transactions?q=inv-1", A.h)).items).toHaveLength(1);
    expect((await ok("GET", "/transactions?limit=2", A.h)).nextCursor).toBeTruthy();
    expect((await ok("GET", "/transactions", B.h)).items).toHaveLength(0);

    const upd = await ok("PATCH", `/transactions/${a.id}`, A.h, { status: "refunded", description: null });
    expect(upd.status).toBe("refunded");
    expect(upd.description).toBeNull();
    expect((await call("GET", `/transactions/${a.id}`, B.h)).status).toBe(404);
    expect((await call("PATCH", `/transactions/${a.id}`, B.h, { status: "failed" })).status).toBe(404);
    expect((await call("DELETE", `/transactions/${a.id}`, AgentA.h)).status).toBe(403);

    const csv = await call("GET", "/transactions/export.csv?status=pending,refunded,completed", A.h);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    const text = await csv.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("id,external_id,source,amount_cents,currency,status,description,contact_id,contact_name,conversation_id,occurred_at,created_at");
    expect(lines).toHaveLength(4);
    expect(text).toContain("'=HYPERLINK"); // formula neutralised
    expect(text).not.toContain(",=HYPERLINK");
    expect((await call("GET", "/transactions/export.csv", B.h)).status).toBe(200);
    expect((await (await call("GET", "/transactions/export.csv", B.h)).text()).trim().split("\r\n")).toHaveLength(1);
    expect((await call("GET", "/transactions/export.csv", ViewerA.h)).status).toBe(403);
  });

  test("transactions: CSV export streams across batches", async () => {
    const t = await mkTenant("bulkcsv");
    await owner`INSERT INTO transactions (tenant_id, amount_cents, currency, occurred_at) SELECT ${t.tenantId}, g, 'EUR', now() - (g || ' minutes')::interval FROM generate_series(1, 1203) g`;
    const text = await (await call("GET", "/transactions/export.csv", t.h)).text();
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(1204);
    expect(new Set(lines.slice(1).map((l) => l.split(",")[0])).size).toBe(1203);
  });

  test("transactions: inbound webhook HMAC, idempotency, rotation, disable, isolation", async () => {
    expect((await call("POST", "/transactions/webhook-endpoints", AgentA.h, { name: "x" })).status).toBe(403);
    const ep = await ok("POST", "/transactions/webhook-endpoints", A.h, { name: "Stripe-ish" }, 201);
    expect(ep.secret).toMatch(/^whsec_/);
    expect(ep.url).toContain(`/api/v1/webhooks/transactions/${ep.id}`);
    // secret is stored encrypted, never returned again
    const [row] = await owner`SELECT secret_encrypted FROM transaction_webhook_endpoints WHERE id = ${ep.id}`;
    expect(row!.secret_encrypted).not.toContain(ep.secret);
    expect(JSON.stringify(await ok("GET", "/transactions/webhook-endpoints", A.h))).not.toContain(ep.secret);

    const { contactId } = await mkContactAndConv(A);
    const [ct] = await owner`SELECT email FROM contacts WHERE id = ${contactId}`;
    const body = JSON.stringify({ externalId: "evt_1", amountCents: 4200, currency: "usd", description: "Order 1", contactEmail: String(ct!.email).toUpperCase(), metadata: { sku: "a" } });
    const send = (b: string, secret: string, tsOffset = 0, path = ep.id) => {
      const ts = String(Math.floor(Date.now() / 1000) + tsOffset);
      return app.request(`/api/v1/webhooks/transactions/${path}`, {
        method: "POST", headers: { "content-type": "application/json", "x-yulona-timestamp": ts, "x-yulona-signature": signWebhook(secret, ts, b) }, body: b,
      });
    };
    const r1 = await send(body, ep.secret);
    expect(r1.status).toBe(200);
    const o1 = await j(r1);
    expect(o1.created).toBe(true);
    const tx = await ok("GET", `/transactions/${o1.id}`, A.h);
    expect(tx.source).toBe("webhook");
    expect(tx.contactId).toBe(contactId);
    expect(tx.amountCents).toBe(4200);
    // replay => update, no duplicate
    const r2 = await j(await send(JSON.stringify({ externalId: "evt_1", amountCents: 4200, currency: "USD", status: "refunded" }), ep.secret));
    expect(r2).toEqual({ id: o1.id, created: false });
    expect((await ok("GET", `/transactions/${o1.id}`, A.h)).status).toBe("refunded");
    expect((await ok("GET", "/transactions?source=webhook", A.h)).items).toHaveLength(1);

    // rejections: all 401 with the same message
    const msgs = new Set<string>();
    for (const res of [
      await send(body, "wrong-secret"), await send(body, ep.secret, -3600), await send(body, ep.secret, 0, crypto.randomUUID()), await send(body, ep.secret, 0, "not-a-uuid"),
      await app.request(`/api/v1/webhooks/transactions/${ep.id}`, { method: "POST", body }),
    ]) {
      expect(res.status).toBe(401);
      msgs.add((await j(res)).error.message);
    }
    expect(msgs.size).toBe(1);
    // strict body after a valid signature
    expect((await send(JSON.stringify({ externalId: "e", amountCents: 1, currency: "USD", tenantId: B.tenantId }), ep.secret)).status).toBe(400);
    expect((await send("not json", ep.secret)).status).toBe(400);
    expect((await send("x".repeat(70_000), ep.secret)).status).toBe(413);

    // B cannot manage A's endpoint
    expect((await call("DELETE", `/transactions/webhook-endpoints/${ep.id}`, B.h)).status).toBe(404);
    expect((await call("POST", `/transactions/webhook-endpoints/${ep.id}/rotate-secret`, B.h)).status).toBe(404);
    // transactions created via A's endpoint stay in A
    expect((await ok("GET", "/transactions", B.h)).items.every((x: any) => x.source !== "webhook")).toBe(true);

    // rotate invalidates the old secret
    const rot = await ok("POST", `/transactions/webhook-endpoints/${ep.id}/rotate-secret`, A.h);
    expect((await send(body, ep.secret)).status).toBe(401);
    expect((await send(JSON.stringify({ externalId: "evt_2", amountCents: 1, currency: "USD" }), rot.secret)).status).toBe(200);
    // disable
    await ok("PATCH", `/transactions/webhook-endpoints/${ep.id}`, A.h, { enabled: false });
    expect((await send(body, rot.secret)).status).toBe(401);
    await ok("DELETE", `/transactions/webhook-endpoints/${ep.id}`, A.h);
  });

  // ------------------------------------------------------------ calendar + bookings
  async function connectCalendar(t: Tenant) {
    const { url } = await ok("POST", "/calendar/google/connect", t.h);
    expect(url).toContain(`${googleBase()}/auth`);
    const state = new URL(url).searchParams.get("state")!;
    expect(new URL(url).searchParams.get("access_type")).toBe("offline");
    const res = await app.request(`/api/v1/calendar/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    return res.headers.get("location")!;
  }

  test("calendar: connect via OAuth (state-bound, tokens encrypted), roles, tenant scoping", async () => {
    expect(await ok("GET", "/calendar/connection", A.h)).toEqual({ connected: false });
    expect((await call("POST", "/calendar/google/connect", AgentA.h)).status).toBe(403);
    const loc = await connectCalendar(A);
    expect(loc).toBe("https://app.example.test/settings/integrations?calendar=connected");
    const conn = await ok("GET", "/calendar/connection", A.h);
    expect(conn).toMatchObject({ connected: true, provider: "google", accountEmail: "owner@cal.test", calendarId: "primary", status: "active" });
    expect(JSON.stringify(conn)).not.toContain("rt-secret");
    const [row] = await owner`SELECT credentials_encrypted FROM calendar_connections WHERE tenant_id = ${A.tenantId}`;
    expect(row!.credentials_encrypted).not.toContain("rt-secret-xyz");
    expect(row!.credentials_encrypted.startsWith("v1.")).toBe(true);
    expect(await ok("GET", "/calendar/connection", B.h)).toEqual({ connected: false });
    // forged / tampered / foreign state
    expect((await app.request(`/api/v1/calendar/google/callback?code=abc&state=forged`)).headers.get("location")).toContain("calendar=error&reason=invalid_state");
    expect((await app.request(`/api/v1/calendar/google/callback?code=abc`)).headers.get("location")).toContain("invalid_state");
    const denied = signState(SECRET, { tenantId: B.tenantId, userId: B.userId });
    expect((await app.request(`/api/v1/calendar/google/callback?error=access_denied&state=${encodeURIComponent(denied)}`)).headers.get("location")).toContain("reason=denied");
    expect(await ok("GET", "/calendar/connection", B.h)).toEqual({ connected: false });
    expect((await ok("PATCH", "/calendar/connection", A.h, { calendarId: "primary" })).connected).toBe(true);
    expect((await call("PATCH", "/calendar/connection", B.h, { calendarId: "x" })).status).toBe(404);
    // B has no calendar
    expect((await call("GET", "/bookings/availability?from=2030-01-07T09:00:00Z&to=2030-01-07T12:00:00Z", B.h)).status).toBe(409);
  });

  test("bookings: availability (busy + business hours), create, overlap, cancel, isolation", async () => {
    // business hours: Monday 2030-01-07 10:00-12:00 UTC only
    await ok("PUT", "/ops/settings", A.h, { timezone: "UTC", businessHours: [{ weekday: 1, start: "10:00", end: "12:00" }] });
    g.busy = [{ start: "2030-01-07T11:00:00Z", end: "2030-01-07T11:30:00Z" }];
    const av = await ok("GET", "/bookings/availability?from=2030-01-07T08:00:00Z&to=2030-01-07T14:00:00Z&durationMinutes=30", A.h);
    expect(av.slots.map((s: any) => s.start)).toEqual(["2030-01-07T10:00:00.000Z", "2030-01-07T10:30:00.000Z", "2030-01-07T11:30:00.000Z"]);
    expect((await call("GET", "/bookings/availability?from=2030-01-07T08:00:00Z&to=2030-03-07T14:00:00Z", A.h)).status).toBe(400);

    const { contactId, conversationId } = await mkContactAndConv(A);
    const b1 = await ok("POST", "/bookings", AgentA.h, { startAt: "2030-01-07T10:00:00Z", durationMinutes: 30, title: "Demo", contactId, conversationId, attendeeEmail: "cora@example.test" }, 201);
    expect(b1).toMatchObject({ status: "booked", provider: "google", externalEventId: "ev-1", endAt: "2030-01-07T10:30:00.000Z", contactName: "Cora Contact" });
    expect((g.events.get("ev-1") as any).attendees[0].email).toBe("cora@example.test");
    // conversation advanced to booked (funnel)
    const [st] = await owner`SELECT stage FROM conversation_ai_state WHERE conversation_id = ${conversationId}`;
    expect(st!.stage).toBe("booked");
    // overlap
    expect((await call("POST", "/bookings", A.h, { startAt: "2030-01-07T10:15:00Z", durationMinutes: 30 })).status).toBe(409);
    expect((await call("POST", "/bookings", A.h, { startAt: "2030-01-07T10:30:00Z", durationMinutes: 30 })).status).toBe(201);
    expect((await call("POST", "/bookings", A.h, { startAt: "2030-01-07T10:30:00Z", endAt: "2030-01-07T11:00:00Z", durationMinutes: 30 })).status).toBe(400);
    expect((await call("POST", "/bookings", ViewerA.h, { startAt: "2030-01-08T10:30:00Z" })).status).toBe(403);
    expect((await call("POST", "/bookings", A.h, { startAt: "2030-01-09T10:00:00Z", contactId: crypto.randomUUID() })).status).toBe(400);
    // list / get / isolation
    expect((await ok("GET", "/bookings?from=2030-01-01T00:00:00Z", A.h)).items.map((x: any) => x.id)[0]).toBe(b1.id);
    expect((await ok("GET", `/bookings?conversationId=${conversationId}`, A.h)).items).toHaveLength(1);
    expect((await ok("GET", "/bookings", B.h)).items).toHaveLength(0);
    expect((await call("GET", `/bookings/${b1.id}`, B.h)).status).toBe(404);
    expect((await call("POST", `/bookings/${b1.id}/cancel`, B.h, {})).status).toBe(404);
    // cancel
    const cancelled = await ok("POST", `/bookings/${b1.id}/cancel`, AgentA.h, { reason: "customer asked" });
    expect(cancelled.status).toBe("cancelled");
    expect(g.deleted).toContain("ev-1");
    expect((await call("POST", `/bookings/${b1.id}/cancel`, A.h, {})).status).toBe(409);
    // the slot is free again
    expect((await call("POST", "/bookings", A.h, { startAt: "2030-01-07T10:00:00Z", durationMinutes: 30 })).status).toBe(201);
    await ok("PUT", "/ops/settings", A.h, { businessHours: [] });
  });

  test("bookings: calendar 5xx/timeout => bounded retries, failed booking, no leak; AI path raises system_failure handoff", async () => {
    // human path: 500 x3 => 503, booking marked failed
    g.eventMode = "500";
    g.eventCalls = 0;
    const res = await call("POST", "/bookings", A.h, { startAt: "2031-02-03T10:00:00Z", durationMinutes: 30 });
    expect(res.status).toBe(503);
    expect(g.eventCalls).toBe(3);
    const failed = await ok("GET", "/bookings?status=failed", A.h);
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0].failureReason).toContain("calendar unavailable");
    expect(JSON.stringify(failed)).not.toContain("rt-secret");
    // failed booking does not block the slot
    g.eventMode = "ok";
    expect((await call("POST", "/bookings", A.h, { startAt: "2031-02-03T10:00:00Z", durationMinutes: 30 })).status).toBe(201);

    // AI path via the calendar tool: hang => timeouts => system_failure handoff + pending_human
    const { conversationId } = await mkContactAndConv(A);
    const cal = await loadTenantCalendar({ db, encryptionKey: KEY, google: new GoogleCalendarClient({ clientId: "cid", clientSecret: "s", redirectUri: "r", tokenUrl: `${googleBase()}/token`, apiBase: `${googleBase()}/calendar/v3` }) }, A.tenantId);
    expect(cal).not.toBeNull();
    const ctx = { db, tenantId: A.tenantId, conversationId, calendar: cal, retry: { attempts: 2, baseMs: 1, timeoutMs: 80 } };
    const slots = await executeCalendarTool(ctx, "check_availability", { from: "2031-03-03T09:00:00Z", to: "2031-03-03T11:00:00Z" });
    expect(slots.kind).toBe("ok");
    expect((slots.output!.slots as any[]).length).toBeGreaterThan(0);
    const [st1] = await owner`SELECT stage FROM conversation_ai_state WHERE conversation_id = ${conversationId}`;
    expect(st1!.stage).toBe("booking_offered");
    expect((await executeCalendarTool(ctx, "book_appointment", { start: "2020-01-01T10:00:00Z" })).error).toBe("start_in_past");
    g.busy = [{ start: "2031-03-03T10:00:00Z", end: "2031-03-03T10:30:00Z" }];
    expect((await executeCalendarTool(ctx, "book_appointment", { start: "2031-03-03T10:00:00Z" })).error).toBe("slot_unavailable");
    g.busy = [];
    g.eventMode = "hang";
    const bad = await executeCalendarTool(ctx, "book_appointment", { start: "2031-03-03T10:00:00Z" });
    expect(bad.kind).toBe("failed");
    const [conv] = await owner`SELECT status FROM conversations WHERE id = ${conversationId}`;
    expect(conv!.status).toBe("pending_human");
    const [h] = await owner`SELECT type, reason FROM handoffs WHERE conversation_id = ${conversationId}`;
    expect(h!.type).toBe("system_failure");
    expect(h!.reason).toContain("booking failed");
    const [st2] = await owner`SELECT stage, ai_paused FROM conversation_ai_state WHERE conversation_id = ${conversationId}`;
    expect(st2).toMatchObject({ stage: "handoff_requested", ai_paused: true });
    // handoff shows in the queue
    const q = await ok("GET", "/needs-attention?type=system_failure", A.h);
    expect(q.items.some((x: any) => x.conversation.id === conversationId)).toBe(true);
    // success path books + advances; no calendar => rejected
    g.eventMode = "ok";
    const { conversationId: c2 } = await mkContactAndConv(A);
    const good = await executeCalendarTool({ ...ctx, conversationId: c2 }, "book_appointment", { start: "2031-03-03T10:00:00Z", attendee_email: "x@y.test" });
    expect(good.kind).toBe("ok");
    expect((await executeCalendarTool({ ...ctx, conversationId: c2, calendar: null }, "check_availability", {})).error).toBe("calendar_not_connected");
    const [st3] = await owner`SELECT stage FROM conversation_ai_state WHERE conversation_id = ${c2}`;
    expect(st3!.stage).toBe("booked");
  });

  test("calendar: expired access token is refreshed and the refreshed tokens are persisted encrypted", async () => {
    const t = await mkTenant("refresh");
    g.expireIn = 1; // already expiring inside the 60s skew
    await connectCalendar(t);
    g.expireIn = 3600;
    const before = g.tokenCalls;
    const av = await ok("GET", "/bookings/availability?from=2032-01-03T09:00:00Z&to=2032-01-03T10:00:00Z", t.h);
    expect(av.slots.length).toBeGreaterThan(0);
    expect(g.tokenCalls).toBe(before + 1); // one refresh
    await ok("GET", "/bookings/availability?from=2032-01-03T09:00:00Z&to=2032-01-03T10:00:00Z", t.h);
    expect(g.tokenCalls).toBe(before + 1); // new token cached in the DB
    await ok("DELETE", "/calendar/connection", t.h);
    expect(await ok("GET", "/calendar/connection", t.h)).toEqual({ connected: false });
  });

  // ------------------------------------------------------------ business hours / settings / availability
  test("business hours SQL: windows, timezone, holidays, default 24/7", async () => {
    const t = await mkTenant("hours");
    const at = async (iso: string) => (await owner`SELECT ops_in_business_hours(${t.tenantId}::uuid, ${iso}::timestamptz) AS o`)[0]!.o as boolean;
    expect(await at("2030-01-06T03:00:00Z")).toBe(true); // nothing configured => always open
    await ok("PUT", "/ops/settings", t.h, { timezone: "America/New_York", businessHours: [{ weekday: 1, start: "09:00", end: "17:00" }, { weekday: 2, start: "09:00", end: "24:00" }] });
    expect(await at("2030-01-07T14:00:00Z")).toBe(true);  // Mon 09:00 NY
    expect(await at("2030-01-07T13:59:00Z")).toBe(false); // 08:59 NY
    expect(await at("2030-01-07T22:00:00Z")).toBe(false); // 17:00 NY
    expect(await at("2030-01-06T15:00:00Z")).toBe(false); // Sunday
    expect(await at("2030-01-08T04:59:00Z")).toBe(false); // Mon 23:59 NY (outside)
    expect(await at("2030-01-08T23:30:00Z")).toBe(true);  // Tue 18:30 NY
    await ok("PUT", "/ops/settings", t.h, { holidays: ["2030-01-08"] });
    expect(await at("2030-01-08T23:30:00Z")).toBe(false);
    const s = await ok("GET", "/ops/settings", t.h);
    expect(s).toMatchObject({ timezone: "America/New_York", holidays: ["2030-01-08"], assignment: { mode: "manual" } });
    expect(s.businessHours).toEqual([{ weekday: 1, start: "09:00", end: "17:00" }, { weekday: 2, start: "09:00", end: "24:00" }]);
    expect(typeof (await ok("GET", "/business-hours/status", t.h)).open).toBe("boolean");
    expect((await call("PUT", "/ops/settings", t.h, { timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await call("PUT", "/ops/settings", t.h, { businessHours: [{ weekday: 1, start: "12:00", end: "09:00" }] })).status).toBe(400);
    expect((await call("PUT", "/ops/settings", t.h, { nonsense: 1 })).status).toBe(400);
    const agent = await mkTenant("hoursAgent", "agent", t.tenantId);
    expect((await call("PUT", "/ops/settings", agent.h, { timezone: "UTC" })).status).toBe(403);
    expect((await call("GET", "/ops/settings", agent.h)).status).toBe(200);
    // other tenants unaffected
    expect((await ok("GET", "/ops/settings", B.h)).businessHours).toEqual([]);
  });

  test("availability: self-service status, team list, no impersonating others", async () => {
    const me = await ok("PUT", "/availability/me", AgentA.h, { status: "online" });
    expect(me).toMatchObject({ userId: AgentA.userId, status: "online" });
    expect((await call("PUT", "/availability/me", AgentA.h, { status: "busy" })).status).toBe(400);
    expect((await call("PUT", "/availability/me", AgentA.h, { status: "online", userId: A.userId })).status).toBe(400);
    expect((await call("PUT", "/availability/me", ViewerA.h, { status: "online" })).status).toBe(403);
    const team = await ok("GET", "/availability", A.h);
    expect(team.items.find((x: any) => x.userId === AgentA.userId).status).toBe("online");
    expect(team.items.find((x: any) => x.userId === A.userId).status).toBe("offline");
    expect(team.items.some((x: any) => x.userId === ViewerA.userId)).toBe(false);
    expect((await ok("GET", "/availability", B.h)).items.some((x: any) => x.userId === AgentA.userId)).toBe(false);
    await ok("PUT", "/availability/me", AgentA.h, { status: "offline" });
  });

  // ------------------------------------------------------------ Needs Attention
  async function mkHandoff(t: Tenant, type: "uncertainty" | "stage" | "system_failure" = "uncertainty") {
    const conv = await mkContactAndConv(t);
    const [h] = await owner<{ id: string }[]>`
      INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary, lead_card) VALUES (${t.tenantId}, ${conv.conversationId}, ${type}, 'no kb match', 'sum',
        ${type === "stage" ? owner.json({ need: "crm", budget: "5k" }) : null}) RETURNING id`;
    await owner`UPDATE conversations SET status = 'pending_human' WHERE id = ${conv.conversationId}`;
    return { ...conv, id: h!.id };
  }

  test("Needs Attention: three types, counts, claim/assign/release/resolve, return to AI, isolation, roles", async () => {
    const t = await mkTenant("queue");
    const agent = await mkTenant("queueAgent", "agent", t.tenantId);
    const agent2 = await mkTenant("queueAgent2", "agent", t.tenantId);
    const viewer = await mkTenant("queueViewer", "viewer", t.tenantId);
    const hu = await mkHandoff(t, "uncertainty");
    const hs = await mkHandoff(t, "stage");
    const hf = await mkHandoff(t, "system_failure");
    const all = await ok("GET", "/needs-attention", agent.h);
    expect(all.items.map((x: any) => x.id)).toEqual([hu.id, hs.id, hf.id]); // oldest first
    expect(all.items[0]).toMatchObject({ state: "open", conversation: { id: hu.conversationId, status: "pending_human" }, contact: { name: "Cora Contact" } });
    expect(all.items[1].leadCard).toMatchObject({ need: "crm" });
    expect(await ok("GET", "/needs-attention/counts", agent.h)).toMatchObject({ uncertainty: 1, stage: 1, system_failure: 1, total: 3, mine: 0 });
    expect((await ok("GET", "/needs-attention?type=stage,system_failure", agent.h)).items).toHaveLength(2);
    expect((await ok("GET", "/needs-attention?limit=1", agent.h)).nextCursor).toBeTruthy();
    expect((await call("GET", "/needs-attention", viewer.h)).status).toBe(403);
    // everyone active got a broadcast notification (no auto-assign), emails pending
    const nn = await ok("GET", "/notifications", agent.h);
    expect(nn.items.filter((n: any) => n.type === "handoff.requested")).toHaveLength(3);
    const pending = (await owner`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = ${t.tenantId} AND email_status = 'pending'`)[0]!.n as number;
    expect(pending).toBeGreaterThanOrEqual(9);

    // cross-tenant
    expect((await call("GET", `/needs-attention/${hu.id}`, B.h)).status).toBe(404);
    expect((await call("POST", `/needs-attention/${hu.id}/claim`, B.h, {})).status).toBe(404);
    expect((await call("POST", `/needs-attention/${hu.id}/resolve`, B.h, {})).status).toBe(404);
    expect((await ok("GET", "/needs-attention", B.h)).items).toHaveLength(0);

    // claim = takeover
    const claimed = await ok("POST", `/needs-attention/${hu.id}/claim`, agent.h, {});
    expect(claimed).toMatchObject({ state: "claimed", assignedUserId: agent.userId, conversation: { status: "open", handler: "human", assignedUserId: agent.userId } });
    expect((await call("POST", `/needs-attention/${hu.id}/claim`, agent2.h, {})).status).toBe(409);
    expect((await call("POST", `/needs-attention/${hu.id}/claim`, agent2.h, { force: true })).status).toBe(409); // force is admin-only
    expect((await ok("POST", `/needs-attention/${hu.id}/claim`, t.h, { force: true })).assignedUserId).toBe(t.userId);
    expect((await call("POST", `/needs-attention/${hu.id}/release`, agent2.h)).status).toBe(403);
    const released = await ok("POST", `/needs-attention/${hu.id}/release`, t.h);
    expect(released).toMatchObject({ state: "open", assignedUserId: null, conversation: { status: "pending_human", handler: "ai" } });
    expect((await call("POST", `/needs-attention/${hu.id}/release`, t.h)).status).toBe(409);
    expect(await ok("GET", "/needs-attention/counts", agent.h)).toMatchObject({ total: 3 });

    // assign (admin) + notification
    expect((await call("POST", `/needs-attention/${hs.id}/assign`, agent.h, { userId: agent2.userId })).status).toBe(403);
    expect((await call("POST", `/needs-attention/${hs.id}/assign`, t.h, { userId: viewer.userId })).status).toBe(400);
    expect((await call("POST", `/needs-attention/${hs.id}/assign`, t.h, { userId: B.userId })).status).toBe(400);
    const assigned = await ok("POST", `/needs-attention/${hs.id}/assign`, t.h, { userId: agent2.userId });
    expect(assigned).toMatchObject({ state: "claimed", assignedUserId: agent2.userId, assignedUserName: "queueAgent2" });
    expect((await ok("GET", "/notifications", agent2.h)).items.some((n: any) => n.type === "handoff.assigned" && n.data.handoffId === hs.id)).toBe(true);
    expect((await ok("GET", "/needs-attention?assignee=me", agent2.h)).items.map((x: any) => x.id)).toEqual([hs.id]);
    expect((await ok("GET", "/needs-attention?state=claimed", agent.h)).items.map((x: any) => x.id)).toEqual([hs.id]);

    // resolve: keep with human
    const res1 = await ok("POST", `/needs-attention/${hf.id}/resolve`, agent.h, { note: "fixed manually" });
    expect(res1).toMatchObject({ state: "resolved", resolvedBy: agent.userId, resolutionNote: "fixed manually", conversation: { status: "open", handler: "human" } });
    expect((await call("POST", `/needs-attention/${hf.id}/resolve`, agent.h, {})).status).toBe(409);
    // resolve + return to AI
    const [aiState] = await owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, stage, ai_paused) VALUES (${t.tenantId}, ${hs.conversationId}, 'handoff_requested', true) RETURNING stage`;
    expect(aiState!.stage).toBe("handoff_requested");
    const res2 = await ok("POST", `/needs-attention/${hs.id}/resolve`, agent2.h, { returnToAi: true });
    expect(res2.conversation).toMatchObject({ status: "open", handler: "ai", assignedUserId: null });
    const [after] = await owner`SELECT stage, ai_paused FROM conversation_ai_state WHERE conversation_id = ${hs.conversationId}`;
    expect(after).toMatchObject({ stage: "engaged", ai_paused: false });
    const [sysMsg] = await owner`SELECT metadata FROM messages WHERE conversation_id = ${hs.conversationId} AND sender_type = 'system'`;
    expect(sysMsg!.metadata).toMatchObject({ event: "returned_to_ai" });
    expect((await ok("GET", "/needs-attention?state=resolved", agent.h)).items).toHaveLength(2);
    expect(await ok("GET", "/needs-attention/counts", agent.h)).toMatchObject({ total: 1 });
  });

  test("handoff routing: least_busy picks the online agent with the fewest open conversations; out-of-hours message", async () => {
    const t = await mkTenant("route");
    const a1 = await mkTenant("routeA1", "agent", t.tenantId);
    const a2 = await mkTenant("routeA2", "agent", t.tenantId);
    const off = await mkTenant("routeOff", "agent", t.tenantId);
    await ok("PUT", "/ops/settings", t.h, { assignment: { mode: "least_busy" }, outOfHours: { mode: "message", message: "We are closed, back soon." } });
    await ok("PUT", "/availability/me", a1.h, { status: "online" });
    await ok("PUT", "/availability/me", a2.h, { status: "online" });
    await ok("PUT", "/availability/me", off.h, { status: "away" });
    // a1 already has 2 open conversations
    for (let i = 0; i < 2; i++) {
      const c = await mkContactAndConv(t);
      await owner`UPDATE conversations SET assigned_user_id = ${a1.userId} WHERE id = ${c.conversationId}`;
    }
    // close the business: today is a holiday in UTC
    const today = new Date().toISOString().slice(0, 10);
    await ok("PUT", "/ops/settings", t.h, { timezone: "UTC", holidays: [today] });
    const h = await mkHandoff(t, "uncertainty");
    const item = await ok("GET", `/needs-attention/${h.id}`, t.h);
    expect(item.assignedUserId).toBe(a2.userId); // online + fewest open conversations (away/offline never)
    expect(item.state).toBe("open");
    expect(item.outOfHours).toBe(true);
    expect(item.conversation.assignedUserId).toBe(a2.userId);
    expect((await ok("GET", "/notifications", a2.h)).items.some((n: any) => n.type === "handoff.assigned")).toBe(true);
    expect((await ok("GET", "/notifications", a1.h)).items.some((n: any) => n.type === "handoff.requested")).toBe(false);
    const [msg] = await owner`SELECT content, sender_type, metadata FROM messages WHERE conversation_id = ${h.conversationId}`;
    expect(msg).toMatchObject({ content: "We are closed, back soon.", sender_type: "ai" });
    expect(msg!.metadata).toMatchObject({ event: "out_of_hours" });
    // open again: no out-of-hours flag/message; nobody online => broadcast
    await ok("PUT", "/ops/settings", t.h, { holidays: [] });
    await ok("PUT", "/availability/me", a2.h, { status: "offline" });
    await ok("PUT", "/availability/me", a1.h, { status: "offline" });
    const h2 = await mkHandoff(t, "stage");
    const item2 = await ok("GET", `/needs-attention/${h2.id}`, t.h);
    expect(item2).toMatchObject({ assignedUserId: null, outOfHours: false });
    expect(await owner`SELECT 1 FROM messages WHERE conversation_id = ${h2.conversationId}`).toHaveLength(0);
    expect((await ok("GET", "/notifications", a1.h)).items.some((n: any) => n.type === "handoff.requested")).toBe(true);
  });

  // ------------------------------------------------------------ canned responses, tags, notifications
  test("canned responses: CRUD, unique shortcut, author/admin rules, search, isolation", async () => {
    const c1 = await ok("POST", "/canned-responses", AgentA.h, { shortcut: "greet", title: "Greeting", content: "Hello! How can I help?" }, 201);
    expect((await call("POST", "/canned-responses", A.h, { shortcut: "greet", title: "x", content: "y" })).status).toBe(409);
    expect((await call("POST", "/canned-responses", A.h, { shortcut: "Bad Shortcut", title: "x", content: "y" })).status).toBe(400);
    expect((await call("POST", "/canned-responses", ViewerA.h, { shortcut: "v", title: "x", content: "y" })).status).toBe(403);
    await ok("POST", "/canned-responses", A.h, { shortcut: "bye", title: "Goodbye", content: "Thanks for chatting, 100% sure." }, 201);
    expect((await ok("GET", "/canned-responses", ViewerA.h)).items.map((x: any) => x.shortcut)).toEqual(["bye", "greet"]);
    expect((await ok("GET", "/canned-responses?q=100%25", A.h)).items.map((x: any) => x.shortcut)).toEqual(["bye"]);
    const p1 = await ok("GET", "/canned-responses?limit=1", A.h);
    expect((await ok("GET", `/canned-responses?limit=1&cursor=${p1.nextCursor}`, A.h)).items[0].shortcut).toBe("greet");
    expect((await ok("GET", "/canned-responses", B.h)).items).toHaveLength(0);
    expect((await call("PATCH", `/canned-responses/${c1.id}`, B.h, { title: "hax" })).status).toBe(404);
    const other = await mkTenant("agentA2", "agent", A.tenantId);
    expect((await call("PATCH", `/canned-responses/${c1.id}`, other.h, { title: "hax" })).status).toBe(403);
    expect((await ok("PATCH", `/canned-responses/${c1.id}`, AgentA.h, { content: "Hi!" })).content).toBe("Hi!");
    expect((await ok("PATCH", `/canned-responses/${c1.id}`, A.h, { title: "Hello" })).title).toBe("Hello");
    expect((await call("DELETE", `/canned-responses/${c1.id}`, other.h)).status).toBe(403);
    await ok("DELETE", `/canned-responses/${c1.id}`, AgentA.h);
    expect((await call("GET", `/canned-responses?cursor=zzz`, A.h)).status).toBe(400);
  });

  test("tags: CRUD, assignment to conversations/contacts/tickets, replace semantics, resources, isolation", async () => {
    const urgent = await ok("POST", "/tags", AgentA.h, { name: "Urgent", color: "#ff0000" }, 201);
    const vip = await ok("POST", "/tags", AgentA.h, { name: "VIP" }, 201);
    expect(vip.color).toBe("#6b7280");
    expect((await call("POST", "/tags", A.h, { name: "urgent" })).status).toBe(409); // case-insensitive unique
    expect((await call("POST", "/tags", A.h, { name: "x", color: "red" })).status).toBe(400);
    expect((await call("POST", "/tags", ViewerA.h, { name: "nope" })).status).toBe(403);
    expect((await call("PATCH", `/tags/${vip.id}`, AgentA.h, { name: "VIPs" })).status).toBe(403);
    expect((await ok("PATCH", `/tags/${vip.id}`, A.h, { name: "VIPs" })).name).toBe("VIPs");

    const { contactId, conversationId } = await mkContactAndConv(A);
    const ticket = await ok("POST", "/tickets", A.h, { title: "tagged", contactId }, 201);
    for (const [path, id] of [["conversations", conversationId], ["contacts", contactId], ["tickets", ticket.id]] as const) {
      expect((await ok("GET", `/${path}/${id}/tags`, A.h)).items).toEqual([]);
      const set = await ok("PUT", `/${path}/${id}/tags`, AgentA.h, { tagIds: [urgent.id, vip.id, urgent.id] });
      expect(set.items.map((x: any) => x.name)).toEqual(["Urgent", "VIPs"]);
      expect((await ok("PUT", `/${path}/${id}/tags`, AgentA.h, { tagIds: [vip.id] })).items.map((x: any) => x.name)).toEqual(["VIPs"]);
      expect((await call("PUT", `/${path}/${id}/tags`, ViewerA.h, { tagIds: [] })).status).toBe(403);
      expect((await call("PUT", `/${path}/${id}/tags`, B.h, { tagIds: [] })).status).toBe(404);
      expect((await call("GET", `/${path}/${id}/tags`, B.h)).status).toBe(404);
      expect((await call("PUT", `/${path}/${crypto.randomUUID()}/tags`, A.h, { tagIds: [] })).status).toBe(404);
    }
    const bTag = await ok("POST", "/tags", B.h, { name: "Bonly" }, 201);
    expect((await call("PUT", `/tickets/${ticket.id}/tags`, A.h, { tagIds: [bTag.id] })).status).toBe(400); // foreign tag id
    expect((await call("PUT", `/tickets/${ticket.id}/tags`, A.h, { tagIds: [vip.id], extra: 1 })).status).toBe(400);
    expect((await ok("GET", `/tickets/${ticket.id}`, A.h)).tags).toEqual([{ id: vip.id, name: "VIPs", color: "#6b7280" }]);
    expect((await ok("GET", `/tickets?tagId=${vip.id}`, A.h)).items.map((x: any) => x.id)).toEqual([ticket.id]);
    const res = await ok("GET", `/tags/${vip.id}/resources?type=conversation`, A.h);
    expect(res.items.map((x: any) => x.resourceId)).toEqual([conversationId]);
    expect((await call("GET", `/tags/${vip.id}/resources?type=conversation`, B.h)).status).toBe(404);
    const list = await ok("GET", "/tags", A.h);
    expect(list.items.find((x: any) => x.id === vip.id).count).toBe(3);
    expect((await ok("GET", "/tags", B.h)).items.map((x: any) => x.name)).toEqual(["Bonly"]);
    await ok("DELETE", `/tags/${vip.id}`, A.h);
    expect((await ok("GET", `/tickets/${ticket.id}`, A.h)).tags).toEqual([]);
    expect((await call("DELETE", `/tags/${urgent.id}`, B.h)).status).toBe(404);
  });

  test("notifications: own-only, read/read-all, preferences gate email, email dispatch with retry", async () => {
    const t = await mkTenant("notif");
    const u = await mkTenant("notifU", "agent", t.tenantId);
    const tk = await ok("POST", "/tickets", t.h, { title: "for u", assigneeUserId: u.userId }, 201);
    const list = await ok("GET", "/notifications", u.h);
    expect(list.items).toHaveLength(1);
    expect(list.unreadCount).toBe(1);
    expect((await ok("GET", "/notifications", t.h)).items).toHaveLength(0); // creator is not notified about their own action
    const nid = list.items[0].id;
    expect((await call("POST", `/notifications/${nid}/read`, t.h)).status).toBe(404); // not yours
    expect((await call("POST", `/notifications/${nid}/read`, B.h)).status).toBe(404);
    // email goes out once
    const email = new MockEmailProvider();
    const r = await dispatchNotificationEmails(db, email, { appUrl: "https://app.example.test" });
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const mine = email.sent.filter((m) => m.subject.includes(`#${tk.number}`) && String(m.to).includes("notifU"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("for u");
    expect((await dispatchNotificationEmails(db, email)).sent).toBe(0);
    // failing provider: retried then marked failed after 5 attempts
    await ok("POST", "/tickets", t.h, { title: "second", assigneeUserId: u.userId }, 201);
    const failing = { name: "fail", send: async () => { throw new Error("smtp down"); } };
    for (let i = 0; i < 5; i++) await dispatchNotificationEmails(db, failing);
    const [st] = await owner`SELECT email_status, email_attempts FROM notifications WHERE user_id = ${u.userId} ORDER BY created_at DESC LIMIT 1`;
    expect(st).toMatchObject({ email_status: "failed", email_attempts: 5 });
    // preferences: email off => no pending email
    expect(await ok("GET", "/notifications/preferences", u.h)).toEqual({ email: true });
    expect(await ok("PUT", "/notifications/preferences", u.h, { email: false })).toEqual({ email: false });
    await ok("POST", "/tickets", t.h, { title: "third", assigneeUserId: u.userId }, 201);
    const [st2] = await owner`SELECT email_status FROM notifications WHERE user_id = ${u.userId} ORDER BY created_at DESC LIMIT 1`;
    expect(st2!.email_status).toBe("none");
    // read / read-all
    expect((await ok("POST", `/notifications/${nid}/read`, u.h)).ok).toBe(true);
    expect((await ok("GET", "/notifications?unread=true", u.h)).items).toHaveLength(2);
    expect(await ok("POST", "/notifications/read-all", u.h)).toEqual({ updated: 2 });
    expect((await ok("GET", "/notifications", u.h)).unreadCount).toBe(0);
    expect((await call("PUT", "/notifications/preferences", u.h, { email: "yes" })).status).toBe(400);
  });

  test("RLS: app role sees nothing without a tenant, owner rows are invisible across tenants", async () => {
    expect(await db`SELECT id FROM tickets`).toHaveLength(0);
    expect(await db`SELECT id FROM transactions`).toHaveLength(0);
    expect(await db`SELECT id FROM bookings`).toHaveLength(0);
    expect(await db`SELECT tenant_id FROM calendar_connections`).toHaveLength(0);
    expect(await db`SELECT id FROM notifications`).toHaveLength(0);
    expect(await db`SELECT id FROM transaction_webhook_endpoints`).toHaveLength(0);
    // only the narrow resolver exposes the (encrypted) webhook secret across tenants
    const [ep] = await owner<{ id: string }[]>`INSERT INTO transaction_webhook_endpoints (tenant_id, name, secret_encrypted) VALUES (${A.tenantId}, 'e', 'enc') RETURNING id`;
    expect(await db`SELECT * FROM ops_txn_endpoint_resolve(${ep!.id}::uuid)`).toHaveLength(1);
    await expect((async () => { await db`INSERT INTO tickets (tenant_id, number, title) VALUES (${A.tenantId}, 999, 'x')`; })()).rejects.toThrow();
  });
});
