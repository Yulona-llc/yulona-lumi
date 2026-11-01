import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { checkRedirectUri, signState } from "@yulona/ops";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { opsRuntimeFromEnv, type OpsRuntime } from "../src/ops/common";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);
const KEY = Buffer.alloc(32, 7).toString("base64");
const CB = "/api/v1/calendar/calendly/callback";

describe("calendly redirect URI pre-flight (pure)", () => {
  test("rules from Calendly: production https only, sandbox may use http on localhost", () => {
    expect(checkRedirectUri("https://api.example.com/cb", "PUBLIC_API_URL", true)).toEqual({ ok: true, warning: null });
    expect(checkRedirectUri("http://localhost:3000/cb", "CALENDLY_REDIRECT_URI", false)).toMatchObject({ ok: true });
    expect((checkRedirectUri("http://localhost:3000/cb", "CALENDLY_REDIRECT_URI", false) as { warning: string }).warning).toMatch(/Sandbox/);
    expect(checkRedirectUri("http://localhost:3000/cb", "localhost_fallback", false)).toMatchObject({ ok: true, warning: expect.stringMatching(/PUBLIC_API_URL is not set/) });
    expect(checkRedirectUri("http://localhost:3000/cb", "CALENDLY_REDIRECT_URI", true)).toMatchObject({ ok: false, code: "localhost_in_production" });
    expect(checkRedirectUri("http://localhost:3000/cb", "localhost_fallback", true)).toMatchObject({ ok: false, code: "localhost_in_production", message: expect.stringMatching(/PUBLIC_API_URL is not set/) });
    expect(checkRedirectUri("http://api.example.com/cb", "PUBLIC_API_URL", false)).toMatchObject({ ok: false, code: "not_https" });
    expect(checkRedirectUri("not a url", "CALENDLY_REDIRECT_URI", false)).toMatchObject({ ok: false, code: "invalid_url" });
    expect(checkRedirectUri("https://api.example.com/cb", "localhost_fallback", false)).toMatchObject({ ok: true, warning: expect.any(String) });
  });
  test("runtime from env records where the URI came from", () => {
    const env = { CALENDLY_CLIENT_ID: "i", CALENDLY_CLIENT_SECRET: "s" };
    const cfg = (publicApiUrl?: string) => ({ ...testConfig(), publicApiUrl, port: 4999 });
    expect(opsRuntimeFromEnv(cfg(), env).calendlyRedirectSource).toBe("localhost_fallback");
    expect(opsRuntimeFromEnv(cfg(), env).calendly?.redirectUri).toBe("http://localhost:4999/api/v1/calendar/calendly/callback");
    expect(opsRuntimeFromEnv(cfg("https://api.x.test/"), env).calendlyRedirectSource).toBe("PUBLIC_API_URL");
    expect(opsRuntimeFromEnv(cfg("https://api.x.test/"), env).calendly?.redirectUri).toBe("https://api.x.test/api/v1/calendar/calendly/callback");
    const o = opsRuntimeFromEnv(cfg("https://api.x.test"), { ...env, CALENDLY_REDIRECT_URI: "https://other.test/cb" });
    expect([o.calendlyRedirectSource, o.calendly?.redirectUri]).toEqual(["CALENDLY_REDIRECT_URI", "https://other.test/cb"]);
  });
});

describe.skipIf(!hasDb)("calendly redirect diagnostics, callback errors and bookings per provider", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  let cal: ReturnType<typeof Bun.serve>;
  let goo: ReturnType<typeof Bun.serve>;
  const calBase = () => `http://localhost:${cal.port}`;
  const gooBase = () => `http://localhost:${goo.port}`;
  const m = { challenge: "", tokenRedirect: "", tokenError: null as null | { error: string; error_description: string }, planFree: false, invitees: [] as any[], googleEvents: [] as any[] };

  function build(over: { calendlyUri?: string; source?: OpsRuntime["calendlyRedirectSource"]; prod?: boolean; google?: boolean }) {
    const cfg = testConfig({}, (c) => { c.encryptionKey = KEY; c.appUrl = "https://app.example.test"; c.publicApiUrl = "https://api.example.test"; c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; if (over.prod) c.isProd = true; });
    return createApp({
      cfg, db, limiter, log: createLogger({ level: "silent" }),
      ops: {
        calendly: { clientId: "cid", clientSecret: "cs", redirectUri: over.calendlyUri ?? `https://api.example.test${CB}`, authUrl: `${calBase()}/oauth/authorize`, tokenUrl: `${calBase()}/oauth/token`, revokeUrl: `${calBase()}/oauth/revoke`, apiBase: calBase() },
        calendlyRedirectSource: over.source,
        ...(over.google ? { google: { clientId: "g", clientSecret: "gs", redirectUri: "https://api.example.test/api/v1/calendar/google/callback", authUrl: `${gooBase()}/auth`, tokenUrl: `${gooBase()}/token`, apiBase: `${gooBase()}/calendar/v3`, revokeUrl: `${gooBase()}/revoke` } } : {}),
        calendarRetry: { attempts: 1, baseMs: 1, timeoutMs: 2000 },
      },
    });
  }
  async function tenant(label: string, role: "owner" | "agent" = "owner") {
    const t = await seedTenantWithUser(owner, label);
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { ...t, h: { authorization: `Bearer ${token}` } as Record<string, string> };
  }
  const req = (app: ReturnType<typeof createApp>, method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const okJson = async (res: Response, status = 200) => { if (res.status !== status) throw new Error(`${res.status} ${await res.text()}`); return (await res.json()) as any; };

  beforeAll(async () => {
    cal = Bun.serve({ port: 0, async fetch(r) {
      const u = new URL(r.url), p = u.pathname;
      if (p === "/oauth/token") {
        const f = new URLSearchParams(await r.text());
        m.tokenRedirect = f.get("redirect_uri") ?? "";
        if (m.tokenError) return Response.json(m.tokenError, { status: 400 });
        if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== m.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 7200, owner: `${calBase()}/users/U1` });
      }
      if (p === "/oauth/revoke") return Response.json({});
      if (p === "/users/me") return Response.json({ resource: { uri: `${calBase()}/users/U1`, email: "o@cal.test", name: "O", timezone: "UTC" } });
      if (p === "/event_types") return Response.json({ collection: [{ uri: `${calBase()}/event_types/ET1`, name: "Intro", duration: 30, active: true, kind: "solo", pooling_type: null }] });
      if (p === "/event_types/ET1") return Response.json({ resource: { uri: `${calBase()}/event_types/ET1`, name: "Intro", duration: 30, active: true } });
      if (p === "/event_type_available_times") return Response.json({ collection: ["2031-03-03T10:00:00.000000Z", "2031-03-03T11:00:00.000000Z"].map((start_time) => ({ status: "available", start_time })) });
      if (p === "/invitees") { if (m.planFree) return Response.json({}, { status: 403 }); m.invitees.push(await r.json()); return Response.json({ resource: { uri: `${calBase()}/scheduled_events/EV1/invitees/I`, event: `${calBase()}/scheduled_events/EV1`, reschedule_url: "https://calendly.com/reschedule/EV1" } }, { status: 201 }); }
      if (p === "/scheduling_links") return Response.json({ resource: { booking_url: "https://calendly.com/d/single-1" } }, { status: 201 });
      return new Response("nf", { status: 404 });
    } });
    goo = Bun.serve({ port: 0, async fetch(r) {
      const p = new URL(r.url).pathname;
      if (p === "/token") return Response.json({ access_token: "ga", refresh_token: "gr", expires_in: 3600 });
      if (p === "/calendar/v3/calendars/primary") return Response.json({ id: "g@cal.test" });
      if (p === "/calendar/v3/freeBusy") return Response.json({ calendars: { primary: { busy: [] } } });
      if (p === "/calendar/v3/calendars/primary/events" && r.method === "POST") { m.googleEvents.push(await r.json()); return Response.json({ id: "gev-1", htmlLink: "https://calendar.google.com/e/1" }); }
      return new Response("nf", { status: 404 });
    } });
    const s = await setupTestDb();
    owner = s.owner; db = s.app; limiter = new MemoryRateLimiter();
  });
  afterAll(async () => { cal?.stop(true); goo?.stop(true); limiter?.close(); await db?.end({ timeout: 2 }); await owner?.end({ timeout: 2 }); });

  test("GET /calendar/connections exposes the effective redirect URI and its source", async () => {
    const t = await tenant("diag");
    const app = build({ source: "PUBLIC_API_URL" });
    const cal1 = (await okJson(await req(app, "GET", "/calendar/connections", t.h))).items.find((x: any) => x.provider === "calendly");
    expect(cal1).toMatchObject({ redirectUri: `https://api.example.test${CB}`, redirectSource: "PUBLIC_API_URL", redirectWarning: null, redirectError: null });
    const fb = build({ calendlyUri: `http://localhost:4000${CB}`, source: "localhost_fallback" });
    expect((await okJson(await req(fb, "GET", "/calendar/connections", t.h))).items[1]).toMatchObject({ redirectSource: "localhost_fallback", redirectWarning: expect.stringMatching(/PUBLIC_API_URL is not set/), redirectError: null });
    const prod = build({ calendlyUri: `http://localhost:4000${CB}`, source: "localhost_fallback", prod: true });
    expect((await okJson(await req(prod, "GET", "/calendar/connections", t.h))).items[1]).toMatchObject({ redirectError: expect.stringMatching(/fell back to localhost/) });
    // an agent cannot read it
    const agent = await tenant("diagagent", "agent");
    expect((await req(app, "GET", "/calendar/connections", agent.h)).status).toBe(403);
  });

  test("connect pre-flight: 400 for http (non-localhost) and for localhost in production; warning (and success) for localhost fallback in dev", async () => {
    const t = await tenant("pre");
    const bad = await req(build({ calendlyUri: `http://api.example.test${CB}`, source: "CALENDLY_REDIRECT_URI" }), "POST", "/calendar/calendly/connect", t.h, {});
    expect(bad.status).toBe(400);
    const bj = await bad.json() as any;
    expect(bj.error.message).toMatch(/https/);
    expect(JSON.stringify(bj)).toContain("invalid_redirect_uri");
    expect((await req(build({ calendlyUri: `http://localhost:4000${CB}`, source: "localhost_fallback", prod: true }), "POST", "/calendar/calendly/connect", t.h, {})).status).toBe(400);
    const dev = await okJson(await req(build({ calendlyUri: `http://localhost:4000${CB}`, source: "localhost_fallback" }), "POST", "/calendar/calendly/connect", t.h, {}));
    expect(dev.redirectUri).toBe(`http://localhost:4000${CB}`);
    expect(dev.warning).toMatch(/PUBLIC_API_URL is not set/);
    expect(new URL(dev.url).searchParams.get("redirect_uri")).toBe(`http://localhost:4000${CB}`);
  });

  test("token exchange sends the same redirect_uri as authorize; Calendly's OAuth error and description reach the dashboard", async () => {
    const t = await tenant("exch");
    const app = build({ source: "PUBLIC_API_URL" });
    const { url } = await okJson(await req(app, "POST", "/calendar/calendly/connect", t.h, {}));
    const u = new URL(url);
    m.challenge = u.searchParams.get("code_challenge")!;
    const authRedirect = u.searchParams.get("redirect_uri");
    m.tokenError = null;
    const good = await app.request(`${CB}?code=abc&state=${encodeURIComponent(u.searchParams.get("state")!)}`.replace(/^/, ""));
    expect(good.headers.get("location")).toContain("calendar=connected");
    expect(m.tokenRedirect).toBe(authRedirect!);

    m.tokenError = { error: "invalid_grant", error_description: "The provided redirect_uri does not match the one registered" };
    const state = signState(SECRET, { tenantId: t.tenantId, userId: t.userId });
    const loc = new URL((await app.request(`${CB}?code=abc&state=${encodeURIComponent(state)}`)).headers.get("location")!);
    expect(loc.searchParams.get("reason")).toBe("invalid_grant");
    expect(loc.searchParams.get("detail")).toContain("redirect_uri does not match");
    m.tokenError = null;

    // error returned on the redirect itself
    const l2 = new URL((await app.request(`${CB}?error=invalid_scope&error_description=${encodeURIComponent("Scope not allowed")}&state=${encodeURIComponent(state)}`)).headers.get("location")!);
    expect([l2.searchParams.get("reason"), l2.searchParams.get("detail")]).toEqual(["invalid_scope", "Scope not allowed"]);
    const l3 = new URL((await app.request(`${CB}?error=access_denied&state=${encodeURIComponent(state)}`)).headers.get("location")!);
    expect([l3.searchParams.get("reason"), l3.searchParams.has("detail")]).toEqual(["denied", false]);
    const l4 = new URL((await app.request(`${CB}?error=${encodeURIComponent("<script>")}&state=${encodeURIComponent(state)}`)).headers.get("location")!);
    expect(l4.searchParams.get("reason")).toBe("provider_error");
  });

  test("bookings with each provider: forced provider on availability and create; offered link on the free plan", async () => {
    const t = await tenant("bk");
    const app = build({ source: "PUBLIC_API_URL", google: true });
    // nothing connected: 409 with a reason the dashboard can act on
    const none = await req(app, "GET", "/bookings/availability?from=2031-03-03T09:00:00Z&to=2031-03-03T12:00:00Z&provider=calendly", t.h);
    expect(none.status).toBe(409);
    expect(JSON.stringify(await none.json())).toContain("calendar_not_connected");
    expect((await req(app, "POST", "/bookings", t.h, { startAt: "2031-03-03T10:00:00Z", provider: "google" })).status).toBe(409);

    const c = await okJson(await req(app, "POST", "/calendar/calendly/connect", t.h, {}));
    m.challenge = new URL(c.url).searchParams.get("code_challenge")!;
    await app.request(`${CB}?code=x&state=${encodeURIComponent(new URL(c.url).searchParams.get("state")!)}`);
    const g = await okJson(await req(app, "POST", "/calendar/google/connect", t.h, {}));
    await app.request(`/api/v1/calendar/google/callback?code=x&state=${encodeURIComponent(new URL(g.url).searchParams.get("state")!)}`);
    const list = await okJson(await req(app, "GET", "/calendar/connections", t.h));
    expect(list.items.every((x: any) => x.connected)).toBe(true);

    const range = "from=2031-03-03T09:00:00Z&to=2031-03-03T12:00:00Z";
    const av = await okJson(await req(app, "GET", `/bookings/availability?${range}&provider=calendly`, t.h));
    expect(av.source).toBe("calendly");
    expect(av.slots).toHaveLength(2);
    expect((await okJson(await req(app, "GET", `/bookings/availability?${range}&provider=google`, t.h))).source).toBe("google");
    expect((await req(app, "GET", `/bookings/availability?${range}&provider=nope`, t.h)).status).toBe(400);

    const gb = await okJson(await req(app, "POST", "/bookings", t.h, { startAt: "2031-03-03T10:00:00Z", durationMinutes: 30, provider: "google", attendeeEmail: "a@b.test" }), 201);
    expect(gb).toMatchObject({ status: "booked", provider: "google", externalEventId: "gev-1" });
    const cb = await okJson(await req(app, "POST", "/bookings", t.h, { startAt: "2031-03-03T11:00:00Z", durationMinutes: 30, provider: "calendly", attendeeEmail: "a@b.test" }), 201);
    expect(cb).toMatchObject({ status: "booked", provider: "calendly", externalEventId: "EV1" });
    expect(m.invitees[0].invitee.email).toBe("a@b.test");

    m.planFree = true;
    const off = await okJson(await req(app, "POST", "/bookings", t.h, { startAt: "2031-03-03T13:00:00Z", durationMinutes: 30, provider: "calendly", attendeeEmail: "z@b.test" }), 201);
    expect(off).toMatchObject({ status: "offered", provider: "calendly", eventUrl: "https://calendly.com/d/single-1" });
    m.planFree = false;
  });
});
