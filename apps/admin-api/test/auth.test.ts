import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { decryptJson } from "@yulona/crypto";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { loadConfig } from "../src/config";
import { sha256, signAdminToken } from "../src/security";
import { hotp, totpStep } from "../src/totp";
import { ADMIN_SECRET, CUSTOMER_SECRET, ENC_KEY, PASSWORD, WEB_ORIGIN, bootAdmin, call, cookieOf, hasDb, jsonOf, mkAdmin, uniq, type AdminBoot } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);
const RT = { "x-admin-request": "1" };

describe.skipIf(!hasDb)("admin auth", () => {
  let b: AdminBoot;
  beforeAll(async () => { b = await bootAdmin(); });
  afterAll(async () => b.close());

  const login = (email: string, password = PASSWORD, extra: Record<string, string> = {}) =>
    b.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ email, password }) });
  const refresh = (cookie?: string, headers: Record<string, string> = RT) =>
    b.app.request("/api/v1/auth/refresh", { method: "POST", headers: { ...headers, ...(cookie ? { cookie: `yl_admin_rt=${cookie}` } : {}) } });

  test("login: session cookie is httpOnly + SameSite=Strict, token works, errors are generic", async () => {
    const a = await mkAdmin(b, "support", { password: PASSWORD });
    const r = await login(a.email);
    expect(r.status).toBe(200);
    const sc = r.headers.getSetCookie().find((c) => c.startsWith("yl_admin_rt="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\/api\/v1\/auth/);
    const s = await jsonOf(r);
    expect(s).toMatchObject({ expiresIn: 900, admin: { email: a.email, role: "support", twoFactorEnabled: false, restricted: null } });
    expect((await call(b, "GET", "/auth/me", { h: { authorization: `Bearer ${s.accessToken}` } })).status).toBe(200);
    // wrong password / unknown email: same status and message
    const bad = await login(a.email, "wrong-password-xx");
    const unknown = await login("nobody@admin.example.test");
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await jsonOf(bad)).error.message).toBe((await jsonOf(unknown)).error.message);
    // login audit
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${a.id} AND action = 'admin.login'`).length).toBe(1);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${a.id} AND action = 'admin.login_failed'`).length).toBe(1);
  });

  test("lockout after 5 failures; disabled admins and tenant users cannot log in", async () => {
    const a = await mkAdmin(b, "billing", { password: PASSWORD });
    for (let i = 0; i < 5; i++) expect((await login(a.email, "wrong-password-xx")).status).toBe(401);
    expect((await login(a.email)).status).toBe(401); // locked even with the right password
    const d = await mkAdmin(b, "billing", { password: PASSWORD });
    await b.owner`UPDATE platform_admins SET status = 'disabled' WHERE id = ${d.id}`;
    expect((await login(d.email)).status).toBe(401);
    const [t] = await b.owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('login-probe') RETURNING id`;
    const email = `${uniq("u")}@customer.example.test`;
    await b.owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t!.id}, ${email}, 'U', 'owner', ${await Bun.password.hash(PASSWORD)})`;
    expect((await login(email)).status).toBe(401); // a customer user is not a platform admin
  });

  test("realms are separate: customer tokens, wrong-secret tokens and challenge tokens are rejected", async () => {
    const a = await mkAdmin(b, "owner");
    const forgedWithCustomerKey = await sign({ sub: a.id, sid: crypto.randomUUID(), typ: "sa", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, CUSTOMER_SECRET, "HS256");
    const customerShaped = await sign({ sub: a.id, tid: crypto.randomUUID(), role: "owner", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, jti: "x" }, CUSTOMER_SECRET, "HS256");
    const challenge = await signAdminToken(ADMIN_SECRET, { sub: a.id, typ: "sa2fa" }, 300);
    const noSid = await sign({ sub: a.id, typ: "sa", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, ADMIN_SECRET, "HS256");
    for (const tok of [forgedWithCustomerKey, customerShaped, challenge, noSid, "garbage", a.token.slice(0, -3) + "abc"]) {
      expect((await call(b, "GET", "/tenants", { h: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    }
    expect((await call(b, "GET", "/tenants", null)).status).toBe(401);
    expect((await call(b, "GET", "/tenants", a)).status).toBe(200);
  });

  test("refresh: needs the header and cookie; rotates; replay of a used token revokes the whole session", async () => {
    const a = await mkAdmin(b, "owner", { password: PASSWORD });
    const l = await login(a.email);
    const c1 = cookieOf(l)!;
    const s1 = await jsonOf(l);
    expect((await refresh(c1, {})).status).toBe(403); // no X-Admin-Request header
    expect((await refresh(undefined)).status).toBe(401);
    expect((await refresh("not-a-token")).status).toBe(401);
    const r2 = await refresh(c1);
    expect(r2.status).toBe(200);
    const c2 = cookieOf(r2)!;
    expect(c2).not.toBe(c1);
    const s2 = await jsonOf(r2);
    expect(s2.accessToken).toBeTruthy();
    // an immediate replay (two tabs) is rejected without punishing the session
    expect((await refresh(c1)).status).toBe(401);
    expect((await refresh(c2)).status).toBe(200);
    // a replay of an old, already used token is theft: the whole family dies, including the access token
    await b.owner`UPDATE admin_sessions SET used_at = now() - interval '1 minute' WHERE token_hash = ${sha256(c1)}`;
    expect((await refresh(c1)).status).toBe(401);
    expect((await call(b, "GET", "/auth/me", { h: { authorization: `Bearer ${s1.accessToken}` } })).status).toBe(401);
    expect((await call(b, "GET", "/auth/me", { h: { authorization: `Bearer ${s2.accessToken}` } })).status).toBe(401);
    expect((await refresh(c2)).status).toBe(401);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${a.id} AND action = 'admin.session_reuse'`).length).toBe(1);
  });

  test("logout revokes the session; deactivation revokes everything at once", async () => {
    const a = await mkAdmin(b, "support", { password: PASSWORD });
    const l = await login(a.email);
    const tok = (await jsonOf(l)).accessToken;
    const cookie = cookieOf(l)!;
    const out = await b.app.request("/api/v1/auth/logout", { method: "POST", headers: { ...RT, cookie: `yl_admin_rt=${cookie}` } });
    expect(out.status).toBe(200);
    expect((await call(b, "GET", "/auth/me", { h: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(401);
    expect((await b.app.request("/api/v1/auth/logout", { method: "POST" })).status).toBe(403); // header required

    const owner = await mkAdmin(b, "owner");
    const l2 = await login(a.email);
    const t2 = (await jsonOf(l2)).accessToken;
    const c2 = cookieOf(l2)!;
    expect((await call(b, "POST", `/admins/${a.id}/deactivate`, owner)).status).toBe(200);
    expect((await call(b, "GET", "/auth/me", { h: { authorization: `Bearer ${t2}` } })).status).toBe(401);
    expect((await refresh(c2)).status).toBe(401);
    expect((await login(a.email)).status).toBe(401);
  });

  test("password change: wrong current rejected, other sessions revoked, forced change restricts the session", async () => {
    const a = await mkAdmin(b, "owner", { password: PASSWORD, mustChange: true });
    const l = await login(a.email);
    const s = await jsonOf(l);
    expect(s.admin.restricted).toBe("password_change");
    const h = { h: { authorization: `Bearer ${s.accessToken}` } };
    const blocked = await call(b, "GET", "/tenants", h);
    expect(blocked.status).toBe(403);
    expect((await jsonOf(blocked)).error).toMatchObject({ code: "session_restricted", details: { reason: "password_change" } });
    expect((await call(b, "GET", "/auth/me", h)).status).toBe(200);
    expect((await call(b, "POST", "/auth/password", h, { currentPassword: "nope-nope-nope-1", newPassword: "a brand new passphrase" })).status).toBe(401);
    expect((await call(b, "POST", "/auth/password", h, { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
    expect((await call(b, "POST", "/auth/password", h, { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    const other = await jsonOf(await login(a.email));
    expect((await call(b, "POST", "/auth/password", h, { currentPassword: PASSWORD, newPassword: "a brand new passphrase" })).status).toBe(200);
    expect((await call(b, "GET", "/tenants", h)).status).toBe(200); // restriction lifted
    expect((await call(b, "GET", "/auth/me", { h: { authorization: `Bearer ${other.accessToken}` } })).status).toBe(401); // other session revoked
    expect((await login(a.email)).status).toBe(401);
    expect((await login(a.email, "a brand new passphrase")).status).toBe(200);
  });

  test("TOTP: enrol, confirm, login second step, replay, recovery codes, disable", async () => {
    const a = await mkAdmin(b, "owner", { password: PASSWORD });
    const h = a;
    expect((await call(b, "POST", "/auth/2fa/setup", h, { password: "wrong-password-xx" })).status).toBe(401);
    const setup = await jsonOf(await call(b, "POST", "/auth/2fa/setup", h, { password: PASSWORD }));
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
    // stored encrypted, not in the clear
    const [row] = await b.owner<{ p: string }[]>`SELECT totp_pending_encrypted AS p FROM platform_admins WHERE id = ${a.id}`;
    expect(row!.p.startsWith("v1.")).toBe(true);
    expect(row!.p).not.toContain(setup.secret);
    expect(decryptJson<{ secret: string }>(ENC_KEY, row!.p, `admin-totp:${a.id}`).secret).toBe(setup.secret);
    // confirm: wrong code, then right code
    expect((await call(b, "POST", "/auth/2fa/confirm", h, { code: "000000" })).status).toBe(400);
    expect((await call(b, "POST", "/auth/2fa/confirm", h, { code: "12" })).status).toBe(400);
    const step = totpStep();
    const conf = await jsonOf(await call(b, "POST", "/auth/2fa/confirm", h, { code: hotp(setup.secret, step) }));
    expect(conf.recoveryCodes).toHaveLength(10);
    expect(new Set(conf.recoveryCodes).size).toBe(10);
    const [stored] = await b.owner<{ h: string[] }[]>`SELECT totp_recovery_hashes AS h FROM platform_admins WHERE id = ${a.id}`;
    expect(stored!.h).toHaveLength(10);
    expect(JSON.stringify(stored!.h)).not.toContain(conf.recoveryCodes[0]); // hashed
    expect((await jsonOf(await call(b, "GET", "/auth/me", h))).twoFactorEnabled).toBe(true);
    expect((await call(b, "POST", "/auth/2fa/setup", h, { password: PASSWORD })).status).toBe(409);

    // login now needs the second step
    const l = await jsonOf(await login(a.email));
    expect(l).toMatchObject({ twoFactorRequired: true });
    expect(l.accessToken).toBeUndefined();
    const second = (body: object) => b.app.request("/api/v1/auth/login/2fa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: l.challengeToken, ...body }) });
    expect((await second({ code: "000000" })).status).toBe(401);
    expect((await second({})).status).toBe(400);
    expect((await second({ code: hotp(setup.secret, step) })).status).toBe(401); // the confirm step was already used: replay
    const ok = await second({ code: hotp(setup.secret, step + 1) });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toBeTruthy();
    expect((await second({ code: hotp(setup.secret, step + 1) })).status).toBe(401); // same code twice
    expect((await b.app.request("/api/v1/auth/login/2fa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: "x".repeat(30), code: "123456" }) })).status).toBe(401);

    // recovery code: works once
    const rc = conf.recoveryCodes[0] as string;
    expect((await second({ recoveryCode: rc })).status).toBe(200);
    expect((await second({ recoveryCode: rc })).status).toBe(401);
    expect((await second({ recoveryCode: conf.recoveryCodes[1].toUpperCase().replace("-", " ") })).status).toBe(200); // normalised

    // disable needs password + a factor
    expect((await call(b, "POST", "/auth/2fa/disable", h, { password: PASSWORD, recoveryCode: "aaaaa-bbbbb" })).status).toBe(401);
    expect((await call(b, "POST", "/auth/2fa/disable", h, { password: "wrong-password-xx", recoveryCode: conf.recoveryCodes[2] })).status).toBe(401);
    expect((await call(b, "POST", "/auth/2fa/disable", h, { password: PASSWORD, recoveryCode: conf.recoveryCodes[2] })).status).toBe(200);
    expect((await jsonOf(await call(b, "GET", "/auth/me", h))).twoFactorEnabled).toBe(false);
    expect((await jsonOf(await login(a.email))).accessToken).toBeTruthy();
    const acts = (await b.owner<{ action: string }[]>`SELECT action FROM platform_audit_logs WHERE admin_id = ${a.id}`).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["admin.2fa.enabled", "admin.2fa.disabled"]));
  });

  test("ADMIN_REQUIRE_2FA: unenrolled admins get a restricted session until they enrol; disabling is refused", async () => {
    const a = await mkAdmin(b, "owner", { password: PASSWORD });
    b.cfg.require2fa = true;
    try {
      const s = await jsonOf(await login(a.email));
      expect(s.admin.restricted).toBe("two_factor_enrolment");
      const h = { h: { authorization: `Bearer ${s.accessToken}` } };
      const r = await call(b, "GET", "/overview", h);
      expect(r.status).toBe(403);
      expect((await jsonOf(r)).error.details).toEqual({ reason: "two_factor_enrolment" });
      const setup = await jsonOf(await call(b, "POST", "/auth/2fa/setup", h, { password: PASSWORD }));
      expect((await call(b, "POST", "/auth/2fa/confirm", h, { code: hotp(setup.secret, totpStep()) })).status).toBe(200);
      expect((await call(b, "GET", "/overview", h)).status).toBe(200);
      expect((await call(b, "POST", "/auth/2fa/disable", h, { password: PASSWORD, code: hotp(setup.secret, totpStep() + 1) })).status).toBe(403);
    } finally { b.cfg.require2fa = false; }
  });

  test("2FA unavailable without ENCRYPTION_KEY (503)", async () => {
    const nb = await bootAdmin({ patch: (c) => { c.encryptionKey = undefined; } });
    try {
      const a = await mkAdmin(nb, "owner", { password: PASSWORD });
      expect((await call(nb, "POST", "/auth/2fa/setup", a, { password: PASSWORD })).status).toBe(503);
    } finally { await nb.close(); }
  });
});

describe.skipIf(!hasDb)("admin rate limits and network controls", () => {
  test("30 reads/min and 10 writes/min per admin; login limits", async () => {
    const b = await bootAdmin({ realLimits: true });
    try {
      const a = await mkAdmin(b, "owner");
      const other = await mkAdmin(b, "owner");
      let last = 0;
      for (let i = 0; i < 30; i++) last = (await call(b, "GET", "/plans", a)).status;
      expect(last).toBe(200);
      const over = await call(b, "GET", "/plans", a);
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBeTruthy();
      expect((await call(b, "GET", "/plans", other)).status).toBe(200); // per admin
      for (let i = 0; i < 10; i++) expect((await call(b, "PUT", "/feature-flags/rl.probe", other, { defaultEnabled: false })).status).toBe(200);
      expect((await call(b, "PUT", "/feature-flags/rl.probe", other, { defaultEnabled: false })).status).toBe(429);
      expect((await call(b, "GET", "/plans", other)).status).toBe(200); // reads and writes are separate buckets
      // login per IP+email: 8 attempts per 15 minutes
      let st = 0;
      for (let i = 0; i < 9; i++) st = (await b.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@admin.example.test", password: "whatever-whatever" }) })).status;
      expect(st).toBe(429);
    } finally { await b.close(); }
  });

  test("ADMIN_ALLOWED_CIDRS uses only the proxy-provided client IP; probes are exempt", async () => {
    const b = await bootAdmin({ env: { ADMIN_ALLOWED_CIDRS: "10.0.0.0/8, 2001:db8::/32", TRUST_PROXY: "true" } });
    try {
      const a = await mkAdmin(b, "owner");
      const ask = (xff: string) => b.app.request("/api/v1/tenants", { headers: { ...a.h, "x-forwarded-for": xff } });
      expect((await ask("10.1.2.3")).status).toBe(200);
      expect((await ask("2001:db8::7")).status).toBe(200);
      expect((await ask("::ffff:10.9.9.9")).status).toBe(200);
      const denied = await ask("8.8.8.8");
      expect(denied.status).toBe(403);
      expect((await jsonOf(denied)).error.code).toBe("forbidden");
      expect((await ask("10.1.1.1, 8.8.8.8")).status).toBe(403); // spoofed leftmost entry is ignored: the proxy's view (rightmost) counts
      expect((await ask("8.8.8.8, 10.1.1.1")).status).toBe(200);
      expect((await b.app.request("/healthz", { headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(200);
      expect((await b.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" }, body: "{}" })).status).toBe(403);
    } finally { await b.close(); }
  });

  test("CORS allows exactly the admin web origin; strict security headers on every response", async () => {
    const b = await bootAdmin();
    try {
      const pre = await b.app.request("/api/v1/tenants", { method: "OPTIONS", headers: { origin: WEB_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-admin-request" } });
      expect(pre.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
      expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
      const evil = await b.app.request("/api/v1/tenants", { method: "OPTIONS", headers: { origin: "https://evil.example.test", "access-control-request-method": "GET" } });
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      const r = await b.app.request("/api/v1/tenants", { headers: { origin: "http://localhost:5173" } });
      expect(r.headers.get("access-control-allow-origin")).toBeNull(); // the customer dashboard origin is not allowed
      for (const [k, v] of [["cache-control", "no-store"], ["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "no-referrer"], ["cross-origin-resource-policy", "same-origin"]] as const) expect([k, r.headers.get(k)]).toEqual([k, v]);
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect((await b.app.request("/nope")).status).toBe(404);
    } finally { await b.close(); }
  });
});

describe("admin config", () => {
  const base = { NODE_ENV: "test", ADMIN_JWT_SECRET: ADMIN_SECRET, ADMIN_DB_URL: "postgres://yulona_admin:pw@localhost:5433/db" };
  test("ADMIN_JWT_SECRET is required, long enough and different from JWT_SECRET", () => {
    expect(() => loadConfig({ ...base, ADMIN_JWT_SECRET: undefined })).toThrow(/ADMIN_JWT_SECRET/);
    expect(() => loadConfig({ ...base, ADMIN_JWT_SECRET: "" })).toThrow(/ADMIN_JWT_SECRET/);
    expect(() => loadConfig({ ...base, ADMIN_JWT_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, JWT_SECRET: ADMIN_SECRET })).toThrow(/must differ from JWT_SECRET/);
    expect(loadConfig({ ...base, JWT_SECRET: CUSTOMER_SECRET }).adminJwtSecret).toBe(ADMIN_SECRET);
  });
  test("database URL comes from ADMIN_DB_URL or DATABASE_URL + ADMIN_DB_PASSWORD (role yulona_admin)", () => {
    expect(loadConfig({ ...base, ADMIN_DB_URL: undefined, DATABASE_URL: "postgres://yulona_app:secret@db:5432/yulona", ADMIN_DB_PASSWORD: "adm in" }).databaseUrl)
      .toBe("postgres://yulona_admin:adm%20in@db:5432/yulona");
    expect(() => loadConfig({ ...base, ADMIN_DB_URL: undefined })).toThrow(/ADMIN_DB_URL/);
  });
  test("defaults and validation: port 4100, 2FA not required, CIDRs validated, production demands an https origin", () => {
    const c = loadConfig(base);
    expect([c.port, c.require2fa, c.cookieName, c.rateLimits.read.limit, c.rateLimits.write.limit]).toEqual([4100, false, "yl_admin_rt", 30, 10]);
    expect(loadConfig({ ...base, ADMIN_REQUIRE_2FA: "true" }).require2fa).toBe(true);
    expect(() => loadConfig({ ...base, ADMIN_ALLOWED_CIDRS: "10.0.0.0/33" })).toThrow(/ADMIN_ALLOWED_CIDRS/);
    expect(() => loadConfig({ ...base, ADMIN_ALLOWED_CIDRS: "not-an-ip" })).toThrow(/ADMIN_ALLOWED_CIDRS/);
    expect(loadConfig({ ...base, ADMIN_ALLOWED_CIDRS: "10.0.0.0/8,::1" }).allowedCidrs).toEqual(["10.0.0.0/8", "::1"]);
    const prod = { ...base, NODE_ENV: "production", ADMIN_JWT_SECRET: "Zq8Lw3RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0Wk3Jv9sXp".replace("Zq", "Qz"), ADMIN_DB_URL: "postgres://yulona_admin:Zx9v7Lm2Qp4Rt6@db:5432/yulona" };
    expect(() => loadConfig(prod)).toThrow(/ADMIN_WEB_ORIGIN/);
    expect(() => loadConfig({ ...prod, ADMIN_WEB_ORIGIN: "http://admin.example.com" })).toThrow(/https/);
    expect(loadConfig({ ...prod, ADMIN_WEB_ORIGIN: "https://admin.example.com/" }).webOrigin).toBe("https://admin.example.com");
    expect(() => loadConfig({ ...prod, ADMIN_WEB_ORIGIN: "https://admin.example.com", ADMIN_DB_URL: "postgres://yulona_admin:yulona_admin@db/x" })).toThrow(/password/);
  });
});
