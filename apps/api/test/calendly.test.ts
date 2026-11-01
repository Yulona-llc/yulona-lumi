import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { CalendlyClient, executeCalendarTool, loadTenantCalendarAny, openCalendlyTokens, pkceChallenge, pkceVerifier, signState } from "@yulona/ops";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const KEY = Buffer.alloc(32, 9).toString("base64");
type Tenant = { tenantId: string; userId: string; token: string; h: Record<string, string> };

describe.skipIf(!hasDb)("calendly provider (mock Calendly server)", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  let A: Tenant, B: Tenant, AgentA: Tenant;
  let srv: ReturnType<typeof Bun.serve>;
  const base = () => `http://localhost:${srv.port}`;
  const m = {
    tokenCalls: 0, refreshCalls: 0, expireIn: 7200, challenge: "", codeOk: true, basicOk: true, planFree: false, slots: ["2031-03-03T10:00:00.000000Z", "2031-03-03T11:00:00.000000Z"],
    invitees: [] as any[], links: 0, cancelled: [] as { uuid: string; body: any }[], revoked: 0, availCalls: 0, tokenDelayMs: 0, tokenFail: 0, duration: 45,
    lastAvailQuery: null as URLSearchParams | null,
  };

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
  const ET1 = () => `${base()}/event_types/ET1`;

  async function connect(t: Tenant): Promise<string> {
    const { url } = await ok("POST", "/calendar/calendly/connect", t.h);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${base()}/oauth/authorize`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    m.challenge = u.searchParams.get("code_challenge")!;
    const res = await app.request(`/api/v1/calendar/calendly/callback?code=abc&state=${encodeURIComponent(u.searchParams.get("state")!)}`);
    expect(res.status).toBe(302);
    return res.headers.get("location")!;
  }

  beforeAll(async () => {
    srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const p = u.pathname;
        if (p === "/oauth/token") {
          const basic = req.headers.get("authorization") === `Basic ${Buffer.from("cal-id:cal-secret").toString("base64")}`;
          if (!basic) return Response.json({ error: "invalid_client" }, { status: 401 });
          if (m.tokenDelayMs) await new Promise((r) => setTimeout(r, m.tokenDelayMs));
          const f = new URLSearchParams(await req.text());
          if (m.tokenFail) { m.tokenFail--; return Response.json({ error: "invalid_grant" }, { status: 400 }); }
          if (f.get("grant_type") === "authorization_code") {
            const v = f.get("code_verifier") ?? "";
            if (createHash("sha256").update(v).digest("base64url") !== m.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
            m.tokenCalls++;
            return Response.json({ token_type: "Bearer", access_token: `at-${m.tokenCalls}`, refresh_token: `rt-secret-${m.tokenCalls}`, expires_in: m.expireIn, created_at: 1, owner: `${base()}/users/U1`, organization: "o" });
          }
          if (f.get("grant_type") === "refresh_token") {
            m.refreshCalls++;
            m.tokenCalls++;
            return Response.json({ token_type: "Bearer", access_token: `at-${m.tokenCalls}`, refresh_token: `rt-secret-${m.tokenCalls}`, expires_in: 7200, created_at: 1, owner: `${base()}/users/U1`, organization: "o" });
          }
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        }
        if (p === "/oauth/revoke") { m.revoked++; return Response.json({}); }
        if (!req.headers.get("authorization")?.startsWith("Bearer at-")) return Response.json({ title: "Unauthenticated" }, { status: 401 });
        if (p === "/users/me") return Response.json({ resource: { uri: `${base()}/users/U1`, email: "owner@cal.test", name: "Owner", timezone: "UTC" } });
        if (p === "/event_types" && req.method === "GET") {
          expect(u.searchParams.get("user")).toBe(`${base()}/users/U1`);
          return Response.json({ collection: [
            { uri: ET1(), name: "30 min intro", duration: m.duration, active: true, scheduling_url: "https://calendly.com/owner/intro", kind: "solo", pooling_type: null },
            { uri: `${base()}/event_types/ET2`, name: "Deep dive", duration: 60, active: true, scheduling_url: "https://calendly.com/owner/deep", kind: "solo", pooling_type: null },
          ] });
        }
        const et = /^\/event_types\/(\w+)$/.exec(p);
        if (et && req.method === "GET") {
          if (et[1] === "GONE") return Response.json({ title: "Not Found" }, { status: 404 });
          return Response.json({ resource: { uri: `${base()}/event_types/${et[1]}`, name: et[1] === "ET1" ? "30 min intro" : "Deep dive", duration: et[1] === "ET1" ? m.duration : 60, active: true } });
        }
        if (p === "/event_type_available_times") {
          m.availCalls++;
          m.lastAvailQuery = u.searchParams;
          const s = Date.parse(u.searchParams.get("start_time")!), e = Date.parse(u.searchParams.get("end_time")!);
          if (!(s > Date.now()) || e - s > 31 * 86_400_000) return Response.json({ title: "Bad" }, { status: 400 });
          return Response.json({ collection: m.slots.filter((x) => Date.parse(x) >= s && Date.parse(x) < e).map((start_time) => ({ status: "available", invitees_remaining: 1, start_time, scheduling_url: "https://calendly.com/x" })) });
        }
        if (p === "/invitees" && req.method === "POST") {
          if (m.planFree) return Response.json({ title: "Permission Denied" }, { status: 403 });
          const b = await req.json();
          m.invitees.push(b);
          return Response.json({ resource: { uri: `${base()}/scheduled_events/EV${m.invitees.length}/invitees/I1`, event: `${base()}/scheduled_events/EV${m.invitees.length}`, reschedule_url: `https://calendly.com/reschedule/EV${m.invitees.length}`, cancel_url: "c" } }, { status: 201 });
        }
        if (p === "/scheduling_links" && req.method === "POST") { m.links++; return Response.json({ resource: { booking_url: `https://calendly.com/d/single-${m.links}`, owner_type: "EventType" } }, { status: 201 }); }
        const can = /^\/scheduled_events\/(\w+)\/cancellation$/.exec(p);
        if (can && req.method === "POST") { m.cancelled.push({ uuid: can[1]!, body: await req.json() }); return Response.json({ resource: {} }, { status: 201 }); }
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
        calendly: { clientId: "cal-id", clientSecret: "cal-secret", redirectUri: "https://api.example.test/api/v1/calendar/calendly/callback", authUrl: `${base()}/oauth/authorize`, tokenUrl: `${base()}/oauth/token`, revokeUrl: `${base()}/oauth/revoke`, apiBase: base() },
        calendarRetry: { attempts: 2, baseMs: 1, timeoutMs: 2000 },
      },
    });
    A = await mkTenant("A");
    B = await mkTenant("B");
    AgentA = await mkTenant("agentA", "agent", A.tenantId);
  });
  afterAll(async () => {
    srv?.stop(true);
    limiter.close();
    await db.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });

  test("pkce helpers are deterministic and S256", () => {
    const v = pkceVerifier("s", "state1");
    expect(v).toBe(pkceVerifier("s", "state1"));
    expect(v).not.toBe(pkceVerifier("s", "state2"));
    expect(pkceChallenge(v)).toBe(createHash("sha256").update(v).digest("base64url"));
  });

  test("connect: signed state + PKCE, tokens encrypted, event type auto-selected, roles, CSRF, tenant isolation", async () => {
    expect((await call("POST", "/calendar/calendly/connect", AgentA.h)).status).toBe(403);
    const none = await ok("GET", "/calendar/connections", A.h);
    expect(none.items.find((x: any) => x.provider === "calendly")).toMatchObject({ configured: true, connected: false });
    expect(none.items.find((x: any) => x.provider === "google")).toMatchObject({ configured: false, connected: false });

    expect(await connect(A)).toBe("https://app.example.test/settings/integrations?calendar=connected&provider=calendly");
    const list = await ok("GET", "/calendar/connections", A.h);
    expect(list.default).toBe("calendly");
    expect(list.items.find((x: any) => x.provider === "calendly")).toMatchObject({ connected: true, accountEmail: "owner@cal.test", calendarId: ET1(), eventTypeSelected: true, status: "active", isDefault: true });
    // tokens are encrypted at rest, never in any API response
    const [row] = await owner`SELECT credentials_encrypted FROM calendar_connections WHERE tenant_id = ${A.tenantId} AND provider = 'calendly'`;
    expect(row!.credentials_encrypted).not.toContain("rt-secret");
    expect(JSON.stringify(list)).not.toContain("rt-secret");
    expect(openCalendlyTokens(KEY, A.tenantId, row!.credentials_encrypted).refreshToken).toBe("rt-secret-1");
    // the envelope is bound to the tenant (AAD): another tenant's id cannot open it
    expect(() => openCalendlyTokens(KEY, B.tenantId, row!.credentials_encrypted)).toThrow();

    // forged / missing / denied / foreign-tenant PKCE mismatch
    expect((await app.request(`/api/v1/calendar/calendly/callback?code=abc&state=forged`)).headers.get("location")).toContain("reason=invalid_state");
    expect((await app.request(`/api/v1/calendar/calendly/callback?code=abc`)).headers.get("location")).toContain("invalid_state");
    const denied = signState(SECRET, { tenantId: B.tenantId, userId: B.userId });
    expect((await app.request(`/api/v1/calendar/calendly/callback?error=access_denied&state=${encodeURIComponent(denied)}`)).headers.get("location")).toContain("reason=denied");
    // a validly signed state whose PKCE challenge was never sent to Calendly: token exchange rejected, nothing stored
    const stray = signState(SECRET, { tenantId: B.tenantId, userId: B.userId });
    m.challenge = "something-else";
    expect((await app.request(`/api/v1/calendar/calendly/callback?code=abc&state=${encodeURIComponent(stray)}`)).headers.get("location")).toContain("reason=invalid_grant");

    // B sees nothing of A
    const bl = await ok("GET", "/calendar/connections", B.h);
    expect(bl.default).toBeNull();
    expect(bl.items.every((x: any) => x.connected === false)).toBe(true);
    expect((await call("GET", "/calendar/calendly/event-types", B.h)).status).toBe(404);
    expect((await call("PATCH", "/calendar/calendly/event-type", B.h, { eventTypeUri: ET1() })).status).toBe(404);
    expect((await call("DELETE", "/calendar/calendly/connection", B.h)).status).toBe(404);
    expect((await call("POST", "/calendar/default", B.h, { provider: "calendly" })).status).toBe(404);
    // roles
    expect((await call("GET", "/calendar/connections", AgentA.h)).status).toBe(403);
    expect((await call("GET", "/calendar/calendly/event-types", AgentA.h)).status).toBe(403);
  });

  test("event types: list, choose (validated against Calendly), strict body", async () => {
    const et = await ok("GET", "/calendar/calendly/event-types", A.h);
    expect(et.items.map((x: any) => [x.name, x.durationMinutes, x.selected])).toEqual([["30 min intro", 45, true], ["Deep dive", 60, false]]);
    expect((await call("PATCH", "/calendar/calendly/event-type", A.h, { eventTypeUri: "https://evil.example/event_types/X" })).status).toBe(400);
    expect((await call("PATCH", "/calendar/calendly/event-type", A.h, { eventTypeUri: `${base()}/event_types/GONE` })).status).toBe(400);
    expect((await call("PATCH", "/calendar/calendly/event-type", A.h, { eventTypeUri: ET1(), extra: 1 })).status).toBe(400);
    const sel = await ok("PATCH", "/calendar/calendly/event-type", A.h, { eventTypeUri: `${base()}/event_types/ET2` });
    expect(sel).toMatchObject({ name: "Deep dive", durationMinutes: 60 });
    await ok("PATCH", "/calendar/calendly/event-type", A.h, { eventTypeUri: ET1() });
    const [aud] = await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action = 'calendar.update'`;
    expect(aud).toBeTruthy();
  });

  test("availability (Calendly decides the length) + booking through the Scheduling API + cancellation", async () => {
    const av = await ok("GET", "/bookings/availability?from=2031-03-03T09:00:00Z&to=2031-03-03T12:00:00Z&durationMinutes=30", A.h);
    expect(av.source).toBe("calendly");
    expect(av.slots).toEqual([
      { start: "2031-03-03T10:00:00.000Z", end: "2031-03-03T10:45:00.000Z" },
      { start: "2031-03-03T11:00:00.000Z", end: "2031-03-03T11:45:00.000Z" },
    ]);
    expect(m.lastAvailQuery!.get("event_type")).toBe(ET1());
    const bk = await ok("POST", "/bookings", A.h, { startAt: "2031-03-03T10:00:00Z", durationMinutes: 45, title: "Intro", attendeeEmail: "cust@example.test", timezone: "Europe/Berlin" }, 201);
    expect(bk).toMatchObject({ status: "booked", provider: "calendly", externalEventId: "EV1" });
    expect(m.invitees[0]).toEqual({ event_type: ET1(), start_time: "2031-03-03T10:00:00.000Z", invitee: { name: "cust", email: "cust@example.test", timezone: "Europe/Berlin" } });
    const cancelled = await ok("POST", `/bookings/${bk.id}/cancel`, A.h, { reason: "customer asked" });
    expect(cancelled.status).toBe("cancelled");
    expect(m.cancelled).toEqual([{ uuid: "EV1", body: { reason: "customer asked" } }]);
    // another tenant cannot cancel it
    expect((await call("POST", `/bookings/${bk.id}/cancel`, B.h, {})).status).toBe(404);
  });

  test("AI tools: slots offered, booked through the invitee API; free plan => single-use link, not booked", async () => {
    const cal = await loadTenantCalendarAny({ db, encryptionKey: KEY, calendly: new CalendlyClient({ clientId: "cal-id", clientSecret: "cal-secret", redirectUri: "r", tokenUrl: `${base()}/oauth/token`, apiBase: base() }) }, A.tenantId);
    expect(cal?.name).toBe("calendly");
    const [ct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name, email) VALUES (${A.tenantId}, 'Cora Contact', 'cora@example.test') RETURNING id`;
    const mkConv = async () => (await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, status, handler) VALUES (${A.tenantId}, ${ct!.id}, 'open', 'ai') RETURNING id`)[0]!.id;
    const c1 = await mkConv();
    await owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, stage) VALUES (${A.tenantId}, ${c1}, 'qualified') ON CONFLICT DO NOTHING`;
    const ctx = { db, tenantId: A.tenantId, conversationId: c1, calendar: cal as any, retry: { attempts: 2, baseMs: 1, timeoutMs: 2000 } };
    const slots = await executeCalendarTool(ctx, "check_availability", { from: "2031-03-03T09:00:00Z", to: "2031-03-03T12:00:00Z", duration_minutes: 10 });
    expect(slots.kind).toBe("ok");
    expect((slots.output as any).durationMinutes).toBe(45); // the event type's length wins over the model's guess
    expect((slots.output as any).slots).toHaveLength(2);
    const booked = await executeCalendarTool(ctx, "book_appointment", { start: "2031-03-03T10:00:00.000Z" });
    expect(booked.kind).toBe("ok");
    expect(booked.output).toMatchObject({ booked: true, end: "2031-03-03T10:45:00.000Z" });
    expect(m.invitees.at(-1).invitee).toMatchObject({ name: "Cora Contact", email: "cora@example.test" });
    const [st] = await owner`SELECT stage FROM conversation_ai_state WHERE conversation_id = ${c1}`;
    expect(st!.stage).toBe("booked");

    // Free plan: Scheduling API answers 403 => single-use link, booking is `offered`, stage not advanced to booked
    m.planFree = true;
    const c2 = await mkConv();
    await owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, stage) VALUES (${A.tenantId}, ${c2}, 'qualified') ON CONFLICT DO NOTHING`;
    const off = await executeCalendarTool({ ...ctx, conversationId: c2 }, "book_appointment", { start: "2031-03-03T11:00:00.000Z" });
    expect(off.kind).toBe("ok");
    expect(off.output).toMatchObject({ booked: false, schedulingLink: "https://calendly.com/d/single-1" });
    const [ob] = await owner`SELECT status, event_url, external_event_id, provider FROM bookings WHERE conversation_id = ${c2}`;
    expect(ob).toMatchObject({ status: "offered", event_url: "https://calendly.com/d/single-1", external_event_id: null, provider: "calendly" });
    const [st2] = await owner`SELECT stage FROM conversation_ai_state WHERE conversation_id = ${c2}`;
    expect(st2!.stage).not.toBe("booked");
    // an offered booking does not block the slot, and can be cancelled without a Calendly call
    const callsBefore = m.cancelled.length;
    const [ob2] = await owner<{ id: string }[]>`SELECT id FROM bookings WHERE conversation_id = ${c2}`;
    await ok("POST", `/bookings/${ob2!.id}/cancel`, A.h, {});
    expect(m.cancelled.length).toBe(callsBefore);
    m.planFree = false;
  });

  test("refresh: rotating token refreshed once even under concurrency, persisted encrypted; permanent failure marks the connection", async () => {
    const t = await mkTenant("refresh");
    m.expireIn = 1;
    await connect(t);
    m.expireIn = 7200;
    const before = m.refreshCalls;
    m.tokenDelayMs = 60;
    const urls = Array.from({ length: 4 }, () => `/bookings/availability?from=2031-03-03T09:00:00Z&to=2031-03-03T12:00:00Z`);
    const res = await Promise.all(urls.map((u) => call("GET", u, t.h)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    m.tokenDelayMs = 0;
    expect(m.refreshCalls).toBe(before + 1); // row lock: single spend of the single-use refresh token
    const [row] = await owner`SELECT credentials_encrypted, status FROM calendar_connections WHERE tenant_id = ${t.tenantId} AND provider = 'calendly'`;
    const tok = openCalendlyTokens(KEY, t.tenantId, row!.credentials_encrypted);
    expect(tok.refreshToken).toBe(`rt-secret-${m.tokenCalls}`);
    expect(row!.credentials_encrypted).not.toContain("rt-secret");
    expect(row!.status).toBe("active");

    // expire again, refresh is rejected (revoked in Calendly) => status error with a reconnect hint, 503 to the caller
    const { encryptJson } = await import("@yulona/ops");
    await owner`UPDATE calendar_connections SET credentials_encrypted = ${encryptJson(KEY, { ...tok, expiresAt: 1 }, `calendar:${t.tenantId}:calendly`)} WHERE tenant_id = ${t.tenantId} AND provider = 'calendly'`;
    m.tokenFail = 5;
    expect((await call("GET", urls[0]!, t.h)).status).toBe(503);
    m.tokenFail = 0;
    const [bad] = await owner`SELECT status, last_error FROM calendar_connections WHERE tenant_id = ${t.tenantId} AND provider = 'calendly'`;
    expect(bad!.status).toBe("error");
    expect(bad!.last_error).toContain("reconnect");
    const conns = await ok("GET", "/calendar/connections", t.h);
    expect(conns.items.find((x: any) => x.provider === "calendly")).toMatchObject({ status: "error", lastError: expect.stringContaining("reconnect") });
    // reconnect heals it
    await connect(t);
    expect((await ok("GET", "/calendar/connections", t.h)).items.find((x: any) => x.provider === "calendly").status).toBe("active");
    await ok("DELETE", "/calendar/calendly/connection", t.h);
  });

  test("default provider endpoint and disconnect wipes tokens (+ revokes at Calendly)", async () => {
    const before = m.revoked;
    expect((await call("POST", "/calendar/default", A.h, { provider: "google" })).status).toBe(404);
    expect((await call("POST", "/calendar/default", A.h, { provider: "nope" })).status).toBe(400);
    expect(await ok("POST", "/calendar/default", A.h, { provider: "calendly" })).toEqual({ default: "calendly" });
    expect(await ok("DELETE", "/calendar/calendly/connection", A.h)).toEqual({ ok: true });
    expect(m.revoked).toBe(before + 1);
    expect(await owner`SELECT 1 FROM calendar_connections WHERE tenant_id = ${A.tenantId}`).toHaveLength(0);
    expect((await ok("GET", "/calendar/connections", A.h)).default).toBeNull();
    expect((await call("GET", "/bookings/availability?from=2031-03-03T09:00:00Z&to=2031-03-03T12:00:00Z", A.h)).status).toBe(409);
    const [aud] = await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action = 'calendar.disconnect'`;
    expect(aud).toBeTruthy();
  });
});
