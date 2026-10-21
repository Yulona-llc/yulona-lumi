import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@yulona/shared";
import { StripeBillingProvider, createMockProviders } from "@yulona/providers";
import { ORIGIN, PASSWORD, api, boot, cookiesOf, hasDb, jsonOf, mkTenant, type Booted, type Tenant } from "../support";

describe.skipIf(!hasDb)("security controls", () => {
  const lines: string[] = [];
  let b: Booted, T: Tenant;
  beforeAll(async () => {
    const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
    b = await boot({ log, patch: (c) => { c.rateLimits.loginIpEmail = { limit: 5, windowMs: 60_000 }; c.rateLimits.register = { limit: 1000, windowMs: 60_000 }; c.rateLimits.docs = { limit: 5, windowMs: 60_000 }; } });
    T = await mkTenant(b, "sec");
  });
  afterAll(async () => b.close());

  const post = (path: string, body: unknown, h: Record<string, string> = {}) => api(b, "POST", path, h, body);
  const register = async () => {
    const email = `r-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const res = await post("/auth/register", { email, password: PASSWORD, name: "Reg", workspaceName: "W" }, { "x-forwarded-for": "9.9.9.9" });
    expect(res.status).toBe(201);
    return { email, res, ck: cookiesOf(res), s: await jsonOf<{ accessToken: string }>(res.clone()) };
  };

  test("secrets never appear in logs (passwords, access/refresh tokens, API keys, CSRF, widget sessions)", async () => {
    const r = await register();
    await post("/auth/login", { email: r.email, password: PASSWORD });
    await post("/auth/login", { email: r.email, password: "wrong-password-123" });
    const key = await jsonOf<{ key: string }>(await api(b, "POST", "/api-keys", { authorization: `Bearer ${r.s.accessToken}` }, { name: "k", scopes: ["contacts:read"] }));
    await api(b, "GET", "/api/v1/key-info", { authorization: `Bearer ${key.key}` });
    await api(b, "GET", "/me", { authorization: `Bearer ${r.s.accessToken}` });
    await api(b, "POST", "/auth/refresh", { cookie: `yl_rt=${r.ck.yl_rt}; yl_csrf=${r.ck.yl_csrf}`, "x-csrf-token": r.ck.yl_csrf! });
    const all = lines.join("\n");
    expect(all.length).toBeGreaterThan(100);
    for (const secret of [PASSWORD, "wrong-password-123", r.s.accessToken, r.ck.yl_rt!, r.ck.yl_csrf!, key.key]) {
      expect(all.includes(secret)).toBe(false);
    }
  });

  test("error responses never expose stack traces or SQL", async () => {
    const res = await api(b, "GET", "/contacts/not-a-uuid", T.h);
    const text = await res.text();
    expect(text).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)|node_modules|SELECT |postgres/i);
    const res2 = await b.app.request("/api/v1/agents", { method: "POST", headers: { ...T.h, "content-type": "application/json" }, body: "{not json" });
    expect(res2.status).toBe(400);
    expect(await res2.text()).not.toMatch(/Unexpected|position/);
  });

  test("CSRF: cookie-authenticated endpoints need the double-submit header", async () => {
    const r = await register();
    const cookie = `yl_rt=${r.ck.yl_rt}; yl_csrf=${r.ck.yl_csrf}`;
    for (const path of ["/auth/refresh", "/auth/logout"]) {
      expect([path, (await api(b, "POST", path, { cookie })).status]).toEqual([path, 403]); // no header
      expect([path, (await api(b, "POST", path, { cookie, "x-csrf-token": "attacker" })).status]).toEqual([path, 403]); // mismatch
      expect([path, (await api(b, "POST", path, { "x-csrf-token": r.ck.yl_csrf! })).status].slice(1)[0]).toBeOneOf([401, 403]); // header but no cookie
    }
    // flags on the refresh cookie
    const sc = r.res.headers.getSetCookie().find((c) => c.startsWith("yl_rt="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=(Strict|Lax)/i);
    expect(sc).toMatch(/Path=\/api\/v1\/auth/i);
    // the access-token (Bearer) API ignores cookies entirely: a cookie alone never authenticates
    expect((await api(b, "GET", "/me", { cookie })).status).toBe(401);
    // a successful rotation works, and reusing the old refresh token revokes the family
    const ok = await api(b, "POST", "/auth/refresh", { cookie, "x-csrf-token": r.ck.yl_csrf! });
    expect(ok.status).toBe(200);
    const again = await api(b, "POST", "/auth/refresh", { cookie, "x-csrf-token": r.ck.yl_csrf! });
    expect(again.status).toBe(401);
    const rotated = cookiesOf(ok);
    const afterReuse = await api(b, "POST", "/auth/refresh", { cookie: `yl_rt=${rotated.yl_rt}; yl_csrf=${rotated.yl_csrf}`, "x-csrf-token": rotated.yl_csrf! });
    expect(afterReuse.status).toBe(401);
  });

  test("CORS: disallowed origins get no ACAO; allowed origin gets credentials; no wildcard", async () => {
    const evil = await b.app.request("/api/v1/me", { headers: { origin: "https://evil.test", ...T.h } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await b.app.request("/api/v1/me", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "GET" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const good = await b.app.request("/api/v1/me", { headers: { origin: "http://localhost:5173", ...T.h } });
    expect(good.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(good.headers.get("access-control-allow-credentials")).toBe("true");
    expect(good.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("rate limits: login lockout per ip+email, docs basic-auth throttle, body size cap", async () => {
    const email = `lock-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await post("/auth/login", { email, password: "wrong-password-123" }, { "x-forwarded-for": "7.7.7.7" })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses).toContain(429);
    const docs: number[] = [];
    for (let i = 0; i < 9; i++) docs.push((await b.app.request("/docs", { headers: { authorization: `Basic ${Buffer.from("docs:wrong").toString("base64")}` } })).status);
    expect(docs).toContain(429);
    expect(docs.filter((s) => s === 401).length).toBeGreaterThan(0);
    const big = await b.app.request("/api/v1/agents", { method: "POST", headers: { ...T.h, "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
  });

  test("rate limits: public widget endpoints throttle per widget+IP; API keys throttle per key", async () => {
    const w = await jsonOf<{ widgetKey: string }>(await api(b, "POST", "/widgets", T.h, { name: "W", allowedDomains: [ORIGIN] }));
    const h = { "x-widget-key": w.widgetKey, origin: ORIGIN };
    const res: number[] = [];
    for (let i = 0; i < 80; i++) res.push((await api(b, "POST", "/public/widget/conversations", h, { visitor: { email: `v${i}@example.test` } })).status);
    expect(res).toContain(429);
    expect(res[0]).toBe(201);
    const cfgRes: number[] = [];
    for (let i = 0; i < 400; i++) cfgRes.push((await api(b, "GET", "/public/widget/config", h)).status);
    expect(cfgRes).toContain(429);
    // per-key limit
    const k = await jsonOf<{ key: string }>(await api(b, "POST", "/api-keys", T.h, { name: "lim", scopes: ["contacts:read"], rateLimitPerMinute: 3 }));
    const ks: number[] = [];
    for (let i = 0; i < 6; i++) ks.push((await api(b, "GET", "/api/v1/public-api/contacts", { authorization: `Bearer ${k.key}` })).status);
    expect(ks.slice(0, 3)).toEqual([200, 200, 200]);
    expect(ks.slice(3)).toContain(429);
    // scope enforcement: a contacts:read key cannot write
    const k2 = await jsonOf<{ key: string }>(await api(b, "POST", "/api-keys", T.h, { name: "ro", scopes: ["contacts:read"] }));
    expect((await api(b, "POST", "/api/v1/public-api/contacts", { authorization: `Bearer ${k2.key}` }, { email: "x@example.test" })).status).toBe(403);
    expect((await api(b, "GET", "/api/v1/public-api/conversations", { authorization: `Bearer ${k2.key}` })).status).toBe(403);
    // revoked key
    const created = await jsonOf<{ id: string; key: string }>(await api(b, "POST", "/api-keys", T.h, { name: "rev", scopes: ["contacts:read"] }));
    expect((await api(b, "DELETE", `/api-keys/${created.id}`, T.h)).status).toBeLessThan(300);
    expect((await api(b, "GET", "/api/v1/public-api/contacts", { authorization: `Bearer ${created.key}` })).status).toBe(401);
  });

  test("uploads: magic bytes, extension allow-list, size caps, unknown multipart fields", async () => {
    const up = (name: string, bytes: Uint8Array | string, extra: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.set("file", new File([bytes as BlobPart], name));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      return b.app.request("/api/v1/knowledge/sources/file", { method: "POST", headers: T.h, body: fd });
    };
    expect((await up("notes.txt", "hello knowledge")).status).toBe(201);
    expect((await up("evil.pdf", "MZ\x90\x00this is an executable")).status).toBe(400); // wrong magic
    expect((await up("evil.exe", "MZ\x90\x00")).status).toBe(400);
    expect((await up("script.html.exe", "<html>")).status).toBe(400);
    expect((await up("a.txt", "x", { tenantId: crypto.randomUUID() })).status).toBe(400);
    expect((await up("big.txt", new Uint8Array(10 * 1024 * 1024 + 10).fill(97))).status).toBe(413);
    const huge = await b.app.request("/api/v1/knowledge/sources/file", { method: "POST", headers: T.h, body: (() => { const fd = new FormData(); fd.set("file", new File([new Uint8Array(12 * 1024 * 1024)], "h.txt")); return fd; })() });
    expect(huge.status).toBe(413);
    // role gate: viewer cannot upload
    const viewer = await mkTenant(b, "viewer", "viewer", T.tenantId);
    const fd = new FormData(); fd.set("file", new File(["x"], "a.txt"));
    expect((await b.app.request("/api/v1/knowledge/sources/file", { method: "POST", headers: viewer.h, body: fd })).status).toBe(403);
  });

  test("SSRF: private/loopback/metadata targets are refused for knowledge URLs and outbound webhooks", async () => {
    for (const url of ["http://127.0.0.1/", "http://localhost:5432/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/", "http://192.168.1.1/", "http://0.0.0.0/", "http://2130706433/", "http://metadata.google.internal/", "file:///etc/passwd", "gopher://127.0.0.1/"]) {
      const k = await api(b, "POST", "/knowledge/sources/url", T.h, { url });
      expect([url, k.status]).toEqual([url, 400]);
      const w = await api(b, "POST", "/webhooks", T.h, { name: "ssrf", url, events: ["message.created"] });
      expect([url, w.status]).toEqual([url, 400]);
    }
  });

  test("billing webhook: real provider rejects unsigned, forged and stale payloads", async () => {
    const stripe = new StripeBillingProvider({ secretKey: "sk_test", webhookSecret: "whsec_x", prices: {}, fetch: (async () => Response.json({})) as never });
    const sb = await boot({ providers: { ...createMockProviders(), billing: stripe } });
    try {
      const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", data: { object: {} } });
      expect((await sb.app.request("/api/v1/webhooks/billing", { method: "POST", body, headers: { "content-type": "application/json" } })).status).toBe(400);
      expect((await sb.app.request("/api/v1/webhooks/billing", { method: "POST", body, headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` } })).status).toBe(400);
      const old = Math.floor(Date.now() / 1000) - 3600;
      expect((await sb.app.request("/api/v1/webhooks/billing", { method: "POST", body, headers: { "stripe-signature": `t=${old},v1=${"0".repeat(64)}` } })).status).toBe(400);
    } finally { await sb.close(); }
  });

  test("JWT hardening: alg=none, wrong key, expired and tampered tokens are all 401", async () => {
    const { signAccessToken } = await import("../../apps/api/src/security");
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: T.userId, tid: T.tenantId, role: "owner", iat: now, exp: now + 900, jti: crypto.randomUUID() };
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
    const expired = await signAccessToken("k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W", { userId: T.userId, tenantId: T.tenantId, role: "owner", ttlSeconds: -60 });
    const good = T.token.split(".");
    const tampered = `${good[0]}.${b64({ ...claims, role: "owner", tid: crypto.randomUUID() })}.${good[2]}`;
    const hs512 = `${b64({ alg: "HS512", typ: "JWT" })}.${b64(claims)}.${good[2]}`;
    for (const t of [none, expired, tampered, hs512, `${good[0]}.${good[1]}.`, "Bearer"]) {
      expect([t.slice(0, 20), (await api(b, "GET", "/me", { authorization: `Bearer ${t}` })).status]).toEqual([t.slice(0, 20), 401]);
    }
  });

  test("privilege escalation: admins cannot mint or promote owners; nobody can change their own role", async () => {
    const admin = await mkTenant(b, "adm", "admin", T.tenantId);
    const agent = await mkTenant(b, "agt2", "agent", T.tenantId);
    expect((await api(b, "POST", "/invitations", admin.h, { email: `o-${crypto.randomUUID().slice(0, 6)}@example.test`, role: "owner" })).status).toBeOneOf([400, 403]);
    expect((await api(b, "PATCH", `/users/${agent.userId}`, admin.h, { role: "owner" })).status).toBeOneOf([400, 403]);
    expect((await api(b, "PATCH", `/users/${T.userId}`, admin.h, { role: "viewer" })).status).toBeOneOf([400, 403]); // demote the owner
    expect((await api(b, "PATCH", `/users/${agent.userId}`, agent.h, { role: "admin" })).status).toBeOneOf([400, 403]);
    expect((await api(b, "PATCH", `/users/${admin.userId}`, admin.h, { role: "owner" })).status).toBeOneOf([400, 403]);
    const roles = await b.owner`SELECT id, role FROM users WHERE tenant_id = ${T.tenantId}`;
    expect(Object.fromEntries(roles.map((r) => [r.id, r.role]))).toMatchObject({ [T.userId]: "owner", [agent.userId]: "agent", [admin.userId]: "admin" });
  });

  test("public widget: tenant-visible only through widget key + allowed Origin; dashboard JWT is not a widget session", async () => {
    const w = await jsonOf<{ widgetKey: string }>(await api(b, "POST", "/widgets", T.h, { name: "O", allowedDomains: [ORIGIN] }));
    expect((await api(b, "GET", "/public/widget/config", { "x-widget-key": w.widgetKey, origin: "https://evil.test" })).status).toBe(403);
    expect((await api(b, "GET", "/public/widget/config", { "x-widget-key": w.widgetKey })).status).toBe(403);
    expect((await api(b, "GET", "/public/widget/messages", { "x-widget-key": w.widgetKey, origin: ORIGIN, ...T.h })).status).toBe(401);
  });
});
