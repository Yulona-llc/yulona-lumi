// Customer side of platform impersonation: the one-time code exchange and the read-only guard.
// Sessions and codes are created the way apps/admin-api does it (sa_start_impersonation_v2, as the DB owner);
// the customer API itself never holds an admin key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { sha256 } from "../src/security";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("impersonation exchange", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let app: ReturnType<typeof createApp>;
  let limiter: MemoryRateLimiter;
  const adminId = crypto.randomUUID();

  beforeAll(async () => {
    const t = await setupTestDb();
    owner = t.owner; db = t.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({}, (c) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; });
    app = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }) });
  });
  afterAll(async () => { limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  const j = async <T = any>(r: Response) => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const exchange = (code: string, ip?: string) => call("POST", "/auth/impersonation/exchange", null, { code }, ip ? { "x-forwarded-for": ip } : {});

  async function newTenant(plan = "pro") {
    const e = uniqueEmail("own");
    const s = await j<{ accessToken: string; tenant: { id: string }; user: { id: string } }>(await app.request("/api/v1/auth/register", json({ email: e, password: PASSWORD, name: "Owner", workspaceName: "WS" })));
    await owner`UPDATE tenants SET plan_key = ${plan} WHERE id = ${s.tenant.id}`;
    return { token: s.accessToken, tenantId: s.tenant.id, userId: s.user.id };
  }
  const start = async (tenantId: string, readOnly: boolean, userId: string | null = null) => {
    const code = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const [s] = await owner<{ r_status: string; r_session: string }[]>`
      SELECT * FROM sa_start_impersonation_v2(${adminId}, ${tenantId}, ${userId}, 'support ticket 1234', ${sha256(code)}, ${readOnly}, 60)`;
    expect(s!.r_status).toBe("ok");
    return { code, sessionId: s!.r_session };
  };

  test("a valid code returns a 15 minute token; the code works exactly once", async () => {
    const t = await newTenant();
    const { code, sessionId } = await start(t.tenantId, false);
    const r = await exchange(code);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const x = await j(r);
    expect(x).toMatchObject({ sessionId, readOnly: false, expiresIn: 900, user: { id: t.userId, role: "admin" }, tenant: { id: t.tenantId } });
    const [s] = await owner<{ expires_at: Date; exchanged_at: Date | null }[]>`SELECT expires_at, exchanged_at FROM impersonation_sessions WHERE id = ${sessionId}`;
    expect(s!.exchanged_at).not.toBeNull();
    expect(s!.expires_at.getTime() - Date.now()).toBeGreaterThan(14 * 60_000); // the lifetime starts at the exchange, not at the start
    const me = await j(await call("GET", "/me", x.accessToken));
    expect(me.impersonation).toMatchObject({ active: true, sessionId, readOnly: false });
    // single use
    const again = await exchange(code);
    expect(again.status).toBe(400);
    expect((await j(again)).error.code).toBe("validation_error");
    // the exchange is audited on the tenant side
    expect((await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'impersonation.exchanged'`).length).toBe(1);
    // the code is stored hashed only
    expect(JSON.stringify(await owner`SELECT * FROM impersonation_codes WHERE session_id = ${sessionId}`)).not.toContain(code);
  });

  test("wrong, malformed, expired, concurrent and revoked codes are all rejected the same way", async () => {
    const t = await newTenant();
    for (const code of ["x".repeat(40), "short", "", crypto.randomUUID().replace(/-/g, "") + "ab"]) {
      expect([code, (await exchange(code)).status]).toEqual([code, 400]);
    }
    expect((await call("POST", "/auth/impersonation/exchange", null, {})).status).toBe(400);
    expect((await call("POST", "/auth/impersonation/exchange", null, { code: "a".repeat(40), tenantId: t.tenantId })).status).toBe(400); // strict body: no tenant from the client
    expect((await app.request("/api/v1/auth/impersonation/exchange", { method: "POST", body: "code=abc" })).status).toBe(415);
    // expired
    const exp = await start(t.tenantId, true);
    await owner`UPDATE impersonation_codes SET expires_at = now() - interval '1 second' WHERE session_id = ${exp.sessionId}`;
    expect((await exchange(exp.code)).status).toBe(400);
    // two parallel redemptions: exactly one wins
    const par = await start(t.tenantId, true);
    const results = await Promise.all([exchange(par.code), exchange(par.code), exchange(par.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    // session ended before the exchange
    const ended = await start(t.tenantId, true);
    await owner`SELECT sa_end_impersonation(${adminId}, ${ended.sessionId})`;
    expect((await exchange(ended.code)).status).toBe(400);
    // tenant suspended before the exchange
    const sus = await newTenant();
    const s2 = await start(sus.tenantId, true);
    await owner`UPDATE tenants SET status = 'suspended' WHERE id = ${sus.tenantId}`;
    expect((await exchange(s2.code)).status).toBe(400);
    // a user disabled before the exchange
    const dis = await newTenant();
    const s3 = await start(dis.tenantId, true);
    await owner`UPDATE users SET status = 'disabled' WHERE id = ${dis.userId}`;
    expect((await exchange(s3.code)).status).toBe(400);
  });

  test("read-only tokens can read but every write is refused; write tokens are scoped and audited", async () => {
    const t = await newTenant();
    const ro = await j(await exchange((await start(t.tenantId, true)).code));
    expect(ro.readOnly).toBe(true);
    const h = ro.accessToken as string;
    expect((await j(await call("GET", "/me", h))).impersonation).toMatchObject({ active: true, readOnly: true });
    for (const path of ["/agents", "/tenant", "/contacts", "/conversations", "/usage/credits", "/audit-logs"]) expect([path, (await call("GET", path, h)).status]).toEqual([path, 200]);
    expect((await call("HEAD", "/agents", h)).status).toBeLessThan(500);
    for (const [m, p, body] of [["POST", "/agents", { name: "x" }], ["PATCH", "/tenant", { name: "Renamed by support" }], ["POST", "/tags", { name: "t" }], ["POST", "/invitations", { email: uniqueEmail("i"), role: "agent" }],
      ["DELETE", `/api-keys/${crypto.randomUUID()}`, undefined], ["PUT", "/ops/settings", {}], ["POST", "/auth/logout", undefined]] as const) {
      const r = await call(m, p, h, body);
      expect([m, p, r.status]).toEqual([m, p, 403]);
      expect((await j(r)).error.message).toContain("read-only");
    }
    expect((await owner`SELECT name FROM tenants WHERE id = ${t.tenantId}`)[0]!.name).not.toBe("Renamed by support");
    expect((await owner`SELECT 1 FROM agents WHERE tenant_id = ${t.tenantId}`).length).toBe(0);

    // write mode: admin-level actions work, owner-only billing does not, writes are audited with the impersonator
    const w = await j(await exchange((await start(t.tenantId, false)).code));
    expect((await call("PATCH", "/tenant", w.accessToken, { name: "Renamed by support" })).status).toBe(200);
    expect((await call("POST", "/billing/checkout", w.accessToken, { plan: "pro" })).status).toBe(403);
    const audit = await owner<{ action: string; metadata: Record<string, unknown> }[]>`SELECT action, metadata FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action IN ('tenant.renamed', 'impersonation.request')`;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.renamed", "impersonation.request"]));
    expect(audit.find((a) => a.action === "tenant.renamed")!.metadata.impersonatorId).toBe(adminId);
    // the tenant sees the impersonation in its own audit log
    const mine = await j<{ items: { action: string; metadata: { readOnly?: boolean } }[] }>(await call("GET", "/audit-logs?action=impersonation.started", t.token));
    expect(mine.items.map((i) => i.metadata.readOnly).sort()).toEqual([false, true]);
    // ending a session kills its token at once; the other session lives on
    await owner`SELECT sa_end_impersonation(${adminId}, ${w.sessionId})`;
    expect((await call("GET", "/me", w.accessToken)).status).toBe(401);
    expect((await call("GET", "/me", h)).status).toBe(200);
    // a customer cannot end sessions or mint impersonation tokens
    expect((await call("POST", `/admin/impersonation/${ro.sessionId}/end`, t.token, {})).status).toBe(404);
  });

  test("a code issued for one tenant never yields a token for another; tokens stay inside their tenant", async () => {
    const a = await newTenant(), b = await newTenant();
    const x = await j(await exchange((await start(a.tenantId, false)).code));
    expect(x.tenant.id).toBe(a.tenantId);
    expect((await j(await call("GET", "/tenant", x.accessToken))).id).toBe(a.tenantId);
    const contactB = (await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${b.tenantId}, 'B only') RETURNING id`)[0]!.id;
    expect((await call("GET", `/contacts/${contactB}`, x.accessToken)).status).toBe(404);
  });

  test("the exchange is rate limited per IP (20/min)", async () => {
    const lim = new MemoryRateLimiter();
    try {
      const cfg = testConfig({ TRUST_PROXY: "true" }, (c) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; });
      const a2 = createApp({ cfg, db, limiter: lim, log: createLogger({ level: "silent" }) });
      let last = 0;
      for (let i = 0; i < 21; i++) {
        last = (await a2.request("/api/v1/auth/impersonation/exchange", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ code: "b".repeat(40) }) })).status;
        if (i < 20) expect(last).toBe(400);
      }
      expect(last).toBe(429);
    } finally { lim.close(); }
  });
});
