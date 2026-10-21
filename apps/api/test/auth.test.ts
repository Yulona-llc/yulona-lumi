import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { CSRF_HEADER, errorEnvelopeSchema, meSchema, sessionSchema } from "@yulona/shared";
import { PASSWORD, cookieHeader, cookiesOf, docsAuth, hasDb, json, makeApp, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

type Ctx = Awaited<ReturnType<typeof makeApp>>;

describe.skipIf(!hasDb)("auth flow", () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await makeApp({}, (c) => { c.rateLimits.register = { limit: 1000, windowMs: 60_000 }; c.rateLimits.global = { limit: 100000, windowMs: 60_000 }; }); });
  afterAll(async () => { await ctx.close(); });

  const register = async (email = uniqueEmail(), ws = "Acme") =>
    ctx.app.request("/api/v1/auth/register", json({ email, password: PASSWORD, name: "Ann", workspaceName: ws }));

  test("register -> session, cookies, /me", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const session = sessionSchema.parse(await res.json());
    expect(session.expiresIn).toBe(900);
    expect(session.user.role).toBe("owner");
    const sc = res.headers.getSetCookie().join("\n");
    expect(sc).toMatch(/yl_rt=[^;]+;.*HttpOnly/i);
    expect(sc).toMatch(/yl_rt=.*Path=\/api\/v1\/auth/i);
    expect(sc).toMatch(/yl_rt=.*SameSite=Strict/i);
    expect(sc).toMatch(/yl_csrf=/);
    expect(sc.split("\n").find((l) => l.startsWith("yl_csrf"))).not.toMatch(/HttpOnly/i);
    expect(JSON.stringify(session)).not.toMatch(/refresh/i);

    const me = await ctx.app.request("/api/v1/me", { headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(meSchema.parse(await me.json()).tenant.id).toBe(session.tenant.id);
  });

  test("duplicate email -> 409; persisted password is argon2id", async () => {
    const email = uniqueEmail();
    expect((await register(email)).status).toBe(201);
    expect((await register(email.toUpperCase())).status).toBe(409);
    const [r] = await ctx.owner`SELECT password_hash FROM users WHERE email = ${email}`;
    expect(r!.password_hash).toStartWith("$argon2id$");
  });

  test("login ok; wrong password / unknown email give identical 401", async () => {
    const email = uniqueEmail();
    await register(email);
    const ok = await ctx.app.request("/api/v1/auth/login", json({ email, password: PASSWORD }));
    expect(ok.status).toBe(200);
    const bad = await ctx.app.request("/api/v1/auth/login", json({ email, password: "wrong-password-123" }));
    const none = await ctx.app.request("/api/v1/auth/login", json({ email: uniqueEmail("nobody"), password: "wrong-password-123" }));
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    const b = errorEnvelopeSchema.parse(await bad.json());
    const n = errorEnvelopeSchema.parse(await none.json());
    expect(b.error.code).toBe(n.error.code);
    expect(b.error.message).toBe(n.error.message);
    expect(b.error.requestId.length).toBeGreaterThan(7);
  });

  test("lockout after repeated failures blocks even the right password", async () => {
    const lctx = await makeApp({}, (c) => { c.rateLimits.loginIpEmail = { limit: 100, windowMs: 1000 }; c.rateLimits.loginIp = { limit: 100, windowMs: 1000 }; });
    try {
      const email = uniqueEmail();
      await lctx.app.request("/api/v1/auth/register", json({ email, password: PASSWORD, name: "L", workspaceName: "L" }));
      for (let i = 0; i < 5; i++) await lctx.app.request("/api/v1/auth/login", json({ email, password: "nope-nope-nope-1" }));
      const res = await lctx.app.request("/api/v1/auth/login", json({ email, password: PASSWORD }));
      expect(res.status).toBe(401);
    } finally { await lctx.close(); }
  });

  test("refresh rotates; old token reuse revokes the whole family", async () => {
    const reg = await register();
    const c1 = cookiesOf(reg);
    const refresh = (c: Record<string, string>, csrf = c.yl_csrf) =>
      ctx.app.request("/api/v1/auth/refresh", { method: "POST", headers: { cookie: cookieHeader(c), ...(csrf ? { [CSRF_HEADER]: csrf } : {}) } });

    const r1 = await refresh(c1);
    expect(r1.status).toBe(200);
    sessionSchema.parse(await r1.json());
    const c2 = cookiesOf(r1);
    expect(c2.yl_rt).not.toBe(c1.yl_rt);

    // replay the old (rotated) token -> reuse detected
    const replay = await refresh(c1);
    expect(replay.status).toBe(401);
    // family revoked: the legitimately rotated token no longer works
    const after = await refresh(c2);
    expect(after.status).toBe(401);
    const [a] = await ctx.owner`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.refresh_reuse_detected'`;
    expect(a!.n).toBeGreaterThan(0);
  });

  test("refresh/logout require CSRF header matching cookie", async () => {
    const c = cookiesOf(await register());
    const noHeader = await ctx.app.request("/api/v1/auth/refresh", { method: "POST", headers: { cookie: cookieHeader(c) } });
    expect(noHeader.status).toBe(403);
    expect((await noHeader.json() as any).error.code).toBe("csrf_failed");
    const wrong = await ctx.app.request("/api/v1/auth/refresh", { method: "POST", headers: { cookie: cookieHeader(c), [CSRF_HEADER]: "nope" } });
    expect(wrong.status).toBe(403);
    const lo = await ctx.app.request("/api/v1/auth/logout", { method: "POST", headers: { cookie: cookieHeader(c) } });
    expect(lo.status).toBe(403);
  });

  test("logout revokes the family and clears cookies", async () => {
    const c = cookiesOf(await register());
    const lo = await ctx.app.request("/api/v1/auth/logout", { method: "POST", headers: { cookie: cookieHeader(c), [CSRF_HEADER]: c.yl_csrf! } });
    expect(lo.status).toBe(200);
    expect(lo.headers.getSetCookie().join("\n")).toMatch(/yl_rt=;/);
    const rf = await ctx.app.request("/api/v1/auth/refresh", { method: "POST", headers: { cookie: cookieHeader(c), [CSRF_HEADER]: c.yl_csrf! } });
    expect(rf.status).toBe(401);
  });

  test("/me rejects missing, malformed, tampered and wrong-secret tokens", async () => {
    const s = sessionSchema.parse(await (await register()).json());
    const get = (t?: string) => ctx.app.request("/api/v1/me", { headers: t ? { authorization: `Bearer ${t}` } : {} });
    expect((await get()).status).toBe(401);
    expect((await get("garbage")).status).toBe(401);
    expect((await get(s.accessToken.slice(0, -3) + "abc")).status).toBe(401);
    const { sign } = await import("hono/jwt");
    const forged = await sign({ sub: s.user.id, tid: s.tenant.id, role: "owner", iat: 1, exp: 9999999999, jti: "x" }, "another-secret-another-secret-another", "HS256");
    expect((await get(forged)).status).toBe(401);
    const none = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." + btoa(JSON.stringify({ sub: s.user.id, tid: s.tenant.id, role: "owner", iat: 1, exp: 9999999999, jti: "x" })).replaceAll("=", "") + ".";
    expect((await get(none)).status).toBe(401);
  });

  test("tenant isolation: each /me returns only its own tenant, tenantId in input is rejected", async () => {
    const a = sessionSchema.parse(await (await register(uniqueEmail(), "TenantA")).json());
    const b = sessionSchema.parse(await (await register(uniqueEmail(), "TenantB")).json());
    expect(a.tenant.id).not.toBe(b.tenant.id);
    const meA = meSchema.parse(await (await ctx.app.request(`/api/v1/me?tenantId=${b.tenant.id}`, { headers: { authorization: `Bearer ${a.accessToken}`, "x-tenant-id": b.tenant.id } })).json());
    expect(meA.tenant.name).toBe("TenantA");
    const res = await ctx.app.request("/api/v1/auth/register", json({ email: uniqueEmail(), password: PASSWORD, name: "x", workspaceName: "y", tenantId: a.tenant.id }));
    expect(res.status).toBe(400);
  });

  test("validation: strict bodies, weak password, bad JSON, media type", async () => {
    const extra = await ctx.app.request("/api/v1/auth/login", json({ email: uniqueEmail(), password: "x", role: "admin" }));
    expect(extra.status).toBe(400);
    const body = errorEnvelopeSchema.parse(await extra.json());
    expect(body.error.code).toBe("validation_error");
    expect(JSON.stringify(body)).not.toContain("admin");
    expect((await ctx.app.request("/api/v1/auth/register", json({ email: uniqueEmail(), password: "short", name: "n", workspaceName: "w" }))).status).toBe(400);
    expect((await ctx.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" })).status).toBe(400);
    expect((await ctx.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
  });

  test("body size limit -> 413", async () => {
    const big = "a".repeat(2 * 1024 * 1024);
    const res = await ctx.app.request("/api/v1/auth/login", json({ email: "a@b.co", password: big }));
    expect(res.status).toBe(413);
  });

  test("signup disabled -> 403", async () => {
    const c2 = await makeApp({ ALLOW_PUBLIC_SIGNUP: "false" });
    try {
      const res = await c2.app.request("/api/v1/auth/register", json({ email: uniqueEmail(), password: PASSWORD, name: "n", workspaceName: "w" }));
      expect(res.status).toBe(403);
      expect((await res.json() as any).error.code).toBe("signup_disabled");
    } finally { await c2.close(); }
  });

  test("login rate limit -> 429 with Retry-After", async () => {
    const c2 = await makeApp({}, (c) => { c.rateLimits.loginIpEmail = { limit: 3, windowMs: 60_000 }; });
    try {
      const email = uniqueEmail();
      const codes: number[] = [];
      let last!: Response;
      for (let i = 0; i < 5; i++) { last = await c2.app.request("/api/v1/auth/login", json({ email, password: "wrong-pass-1234" })); codes.push(last.status); }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    } finally { await c2.close(); }
  });

  test("headers, request id, CORS allowlist, error shape, no stack leak", async () => {
    const res = await ctx.app.request("/healthz", { headers: { "x-request-id": "req-12345678", origin: "http://localhost:5173" } });
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await ctx.app.request("/healthz", { headers: { origin: "http://evil.test" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const nf = await ctx.app.request("/nope");
    expect(nf.status).toBe(404);
    errorEnvelopeSchema.parse(await nf.json());
    const bad = await ctx.app.request("/healthz", { headers: { "x-request-id": "bad id with spaces!!" } });
    expect(bad.headers.get("x-request-id")).not.toBe("bad id with spaces!!");
  });

  test("healthz/readyz and openapi", async () => {
    expect((await ctx.app.request("/healthz")).status).toBe(200);
    const rz = await ctx.app.request("/readyz");
    expect(rz.status).toBe(200);
    const doc = await (await ctx.app.request("/api/v1/openapi.json", { headers: docsAuth() })).json() as any;
    expect(doc.openapi).toStartWith("3.");
    expect(Object.keys(doc.paths)).toContain("/api/v1/auth/login");
    expect(doc.paths["/api/v1/auth/login"].post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    const docs = await ctx.app.request("/docs", { headers: docsAuth() });
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    expect(await docs.text()).toContain("/api/v1/openapi.json");
  });

  test("logger redacts secrets from request logs", async () => {
    const lines: string[] = [];
    const { createLogger } = await import("@yulona/shared");
    const { createApp } = await import("../src/app");
    const { MemoryRateLimiter } = await import("../src/ratelimit");
    const { testConfig } = await import("./helpers");
    const l = new MemoryRateLimiter();
    const app = createApp({ cfg: testConfig(), db: ctx.db, limiter: l, log: createLogger({ write: (x) => lines.push(x) }) });
    const email = uniqueEmail();
    await app.request("/api/v1/auth/login?token=SECRETQUERY", json({ email, password: "hunter2hunter2-LEAK" }, { authorization: "Bearer LEAKTOKEN", cookie: "yl_rt=LEAKCOOKIE" }));
    l.close();
    const all = lines.join("\n");
    expect(all).toContain('"msg":"request"');
    for (const s of ["hunter2", "LEAKTOKEN", "LEAKCOOKIE", "SECRETQUERY"]) expect(all).not.toContain(s);
  });
});
