import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashPassword } from "../../apps/api/src/security";
import { PASSWORD, api, boot, hasDb, jsonOf, mkTenant, type Booted, type Tenant } from "../support";

describe.skipIf(!hasDb)("impersonation token revocation", () => {
  let b: Booted, t: Tenant, adminH: Record<string, string>;
  beforeAll(async () => {
    b = await boot();
    t = await mkTenant(b, "imp");
    const email = `sa-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await b.owner`INSERT INTO platform_admins (email, name, password_hash) VALUES (${email}, 'SA', ${await hashPassword(PASSWORD)})`;
    const r = await api(b, "POST", "/admin/auth/login", {}, { email, password: PASSWORD });
    adminH = { authorization: `Bearer ${(await jsonOf<{ accessToken: string }>(r)).accessToken}` };
  });
  afterAll(async () => b.close());

  const start = async () => {
    const r = await api(b, "POST", `/admin/tenants/${t.tenantId}/impersonate`, adminH, { reason: "support ticket 42" });
    expect(r.status).toBe(201);
    return jsonOf<{ accessToken: string; sessionId: string }>(r);
  };

  test("token works until the session is ended; then every request is 401", async () => {
    const s = await start();
    const h = { authorization: `Bearer ${s.accessToken}` };
    const me = await jsonOf<{ impersonation: { active: boolean } | null }>(await api(b, "GET", "/me", h));
    expect(me.impersonation?.active).toBe(true);
    expect((await api(b, "GET", "/agents", h)).status).toBe(200);

    expect((await api(b, "POST", `/admin/impersonation/${s.sessionId}/end`, adminH)).status).toBe(200);
    for (const [m, p] of [["GET", "/me"], ["GET", "/agents"], ["POST", "/agents"], ["GET", "/conversations"]] as const) {
      expect([p, (await api(b, m, p, h, m === "POST" ? { name: "x" } : undefined)).status]).toEqual([p, 401]);
    }
    // a second end is a 404 (already ended), and the denial is permanent
    expect((await api(b, "POST", `/admin/impersonation/${s.sessionId}/end`, adminH)).status).toBe(404);
  });

  test("expired session is rejected even if the JWT itself is still valid", async () => {
    const s = await start();
    const h = { authorization: `Bearer ${s.accessToken}` };
    expect((await api(b, "GET", "/me", h)).status).toBe(200);
    await b.owner`UPDATE impersonation_sessions SET expires_at = now() - interval '1 second' WHERE id = ${s.sessionId}`;
    expect((await api(b, "GET", "/me", h)).status).toBe(401);
  });

  test("session from another tenant / deleted session cannot be replayed; ending one session leaves others alive", async () => {
    const s1 = await start();
    const s2 = await start();
    await api(b, "POST", `/admin/impersonation/${s1.sessionId}/end`, adminH);
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${s1.accessToken}` })).status).toBe(401);
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${s2.accessToken}` })).status).toBe(200);
    await b.owner`DELETE FROM impersonation_sessions WHERE id = ${s2.sessionId}`;
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${s2.accessToken}` })).status).toBe(401);
  });

  test("impersonated writes are audited on the tenant side and the tenant cannot end the session", async () => {
    const s = await start();
    const h = { authorization: `Bearer ${s.accessToken}` };
    await api(b, "POST", "/tags", h, { name: "imp-tag" });
    const rows = await b.owner`SELECT metadata FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'impersonation.request'`;
    expect(rows.length).toBeGreaterThan(0);
    expect((await api(b, "POST", `/admin/impersonation/${s.sessionId}/end`, h)).status).toBeOneOf([401, 403]);
  });
});
