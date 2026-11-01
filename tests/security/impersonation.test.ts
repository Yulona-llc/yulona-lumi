import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sha256 } from "../../apps/api/src/security";
import { api, boot, hasDb, jsonOf, mkTenant, type Booted, type Tenant } from "../support";

/**
 * Impersonation token revocation. Sessions start through sa_start_impersonation_v2 (what apps/admin-api calls) and the
 * token is minted by the customer API's one-time code exchange.
 */
describe.skipIf(!hasDb)("impersonation token revocation", () => {
  let b: Booted, t: Tenant;
  const adminId = crypto.randomUUID();
  beforeAll(async () => {
    b = await boot();
    t = await mkTenant(b, "imp");
  });
  afterAll(async () => b.close());

  const start = async (readOnly = false) => {
    const code = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    const [s] = await b.owner<{ r_status: string; r_session: string }[]>`SELECT * FROM sa_start_impersonation_v2(${adminId}, ${t.tenantId}, NULL, 'support ticket 42', ${sha256(code)}, ${readOnly}, 60)`;
    expect(s!.r_status).toBe("ok");
    const r = await api(b, "POST", "/auth/impersonation/exchange", {}, { code });
    expect(r.status).toBe(200);
    const x = await jsonOf<{ accessToken: string; sessionId: string }>(r);
    expect(x.sessionId).toBe(s!.r_session);
    return x;
  };
  const end = (sessionId: string) => b.owner`SELECT sa_end_impersonation(${adminId}, ${sessionId})`;

  test("token works until the session is ended; then every request is 401", async () => {
    const s = await start();
    const h = { authorization: `Bearer ${s.accessToken}` };
    const me = await jsonOf<{ impersonation: { active: boolean } | null }>(await api(b, "GET", "/me", h));
    expect(me.impersonation?.active).toBe(true);
    expect((await api(b, "GET", "/agents", h)).status).toBe(200);

    await end(s.sessionId);
    for (const [m, p] of [["GET", "/me"], ["GET", "/agents"], ["POST", "/agents"], ["GET", "/conversations"]] as const) {
      expect([p, (await api(b, m, p, h, m === "POST" ? { name: "x" } : undefined)).status]).toEqual([p, 401]);
    }
    const again = await b.owner<{ ok: boolean }[]>`SELECT sa_end_impersonation(${adminId}, ${s.sessionId}) AS ok`; // a second end is a no-op (the admin API answers 404)
    expect(again[0]!.ok).toBe(false);
  });

  test("expired session is rejected even if the JWT itself is still valid", async () => {
    const s = await start();
    const h = { authorization: `Bearer ${s.accessToken}` };
    expect((await api(b, "GET", "/me", h)).status).toBe(200);
    await b.owner`UPDATE impersonation_sessions SET expires_at = now() - interval '1 second' WHERE id = ${s.sessionId}`;
    expect((await api(b, "GET", "/me", h)).status).toBe(401);
  });

  test("ending one session leaves others alive; a deleted session cannot be replayed", async () => {
    const s1 = await start();
    const s2 = await start();
    await end(s1.sessionId);
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${s1.accessToken}` })).status).toBe(401);
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${s2.accessToken}` })).status).toBe(200);
    await b.owner`DELETE FROM impersonation_sessions WHERE id = ${s2.sessionId}`;
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${s2.accessToken}` })).status).toBe(401);
  });

  test("impersonated writes are audited on the tenant side; read-only sessions cannot write at all; the tenant cannot end a session", async () => {
    const s = await start();
    const h = { authorization: `Bearer ${s.accessToken}` };
    await api(b, "POST", "/tags", h, { name: "imp-tag" });
    const rows = await b.owner`SELECT metadata FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'impersonation.request'`;
    expect(rows.length).toBeGreaterThan(0);
    const ro = await start(true);
    const rh = { authorization: `Bearer ${ro.accessToken}` };
    expect((await api(b, "GET", "/tags", rh)).status).toBe(200);
    expect((await api(b, "POST", "/tags", rh, { name: "must-not-exist" })).status).toBe(403);
    expect((await b.owner`SELECT 1 FROM tags WHERE tenant_id = ${t.tenantId} AND name = 'must-not-exist'`).length).toBe(0);
    for (const hh of [h, t.h]) expect((await api(b, "POST", `/admin/impersonation/${s.sessionId}/end`, hh, {})).status).toBe(404);
    expect((await api(b, "GET", "/me", h)).status).toBe(200); // still alive: the customer API has no way to end it
  });
});
