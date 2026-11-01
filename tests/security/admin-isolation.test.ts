import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { sha256 } from "../../apps/api/src/security";
import { loadConfig as loadAdminConfig } from "../../apps/admin-api/src/config";
import { ADMIN_SECRET, SECRET, api, bootAdminOn, boot, hasDb, mkTenant, type AdminBooted, type Booted, type Tenant } from "../support";

/**
 * The platform-admin service is a separate product: separate process, signing key, cookie and DB identity.
 * These tests pin the isolation promised by the plan.
 */
/** Run a (lazy) query and return the error text, or "ok" when it succeeded. */
const outcome = async (q: PromiseLike<unknown>): Promise<string> => { try { await q; return "ok"; } catch (e) { return String(e); } };

describe.skipIf(!hasDb)("admin platform isolation", () => {
  let b: Booted, ad: AdminBooted, t: Tenant;
  beforeAll(async () => {
    b = await boot();
    ad = await bootAdminOn(b);
    t = await mkTenant(b, "iso");
  });
  afterAll(async () => { await ad.close(); await b.close(); });

  test("the customer API exposes no /api/v1/admin/* (404 for everyone) and no admin cookie realm", async () => {
    const owner = await ad.admin("owner");
    for (const path of ["/admin/tenants", "/admin/auth/login", "/admin/auth/me", "/admin/analytics", "/admin/llm-profiles", `/admin/tenants/${t.tenantId}/impersonate`]) {
      for (const h of [{}, t.h, owner.h]) expect([path, (await api(b, "POST", path, h, {})).status]).toEqual([path, 404]);
      expect([path, (await api(b, "GET", path, t.h)).status]).toEqual([path, 404]);
    }
    expect([...b.app.routes].filter((r) => /\/admin(\/|$)/.test(r.path)).length).toBe(0);
  });

  test("an admin token is rejected by the customer API; a tenant token is rejected by the admin API", async () => {
    const a = await ad.admin("owner");
    for (const path of ["/me", "/agents", "/tenant", "/contacts", "/usage/credits"]) {
      expect([path, (await api(b, "GET", path, a.h)).status]).toEqual([path, 401]);
    }
    expect((await ad.call("GET", "/tenants", t.h)).status).toBe(401);
    expect((await ad.call("GET", "/auth/me", t.h)).status).toBe(401);
    // a token forged with the other realm's secret fails too, whatever claims it carries
    const claims = { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
    const adminShapedWithCustomerKey = await sign({ sub: a.id, sid: crypto.randomUUID(), typ: "sa", ...claims }, SECRET, "HS256");
    const tenantShapedWithAdminKey = await sign({ sub: t.userId, tid: t.tenantId, role: "owner", jti: "x", ...claims }, ADMIN_SECRET, "HS256");
    expect((await ad.call("GET", "/tenants", { authorization: `Bearer ${adminShapedWithCustomerKey}` })).status).toBe(401);
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${tenantShapedWithAdminKey}` })).status).toBe(401);
    expect(ADMIN_SECRET).not.toBe(SECRET);
  });

  test("ADMIN_JWT_SECRET equal to JWT_SECRET (or missing) aborts startup", () => {
    const base = { NODE_ENV: "test", ADMIN_DB_URL: "postgres://yulona_admin:pw@localhost/db" };
    expect(() => loadAdminConfig({ ...base, ADMIN_JWT_SECRET: SECRET, JWT_SECRET: SECRET })).toThrow(/must differ from JWT_SECRET/);
    expect(() => loadAdminConfig({ ...base })).toThrow(/ADMIN_JWT_SECRET/);
    expect(loadAdminConfig({ ...base, ADMIN_JWT_SECRET: ADMIN_SECRET, JWT_SECRET: SECRET }).adminJwtSecret).toBe(ADMIN_SECRET);
  });

  test("yulona_app cannot EXECUTE any sa_* function; yulona_admin can EXECUTE all of them", async () => {
    const fns = await b.owner<{ sig: string }[]>`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'sa\\_%'`;
    expect(fns.length).toBeGreaterThan(80);
    const app = await b.owner<{ sig: string; app: boolean; adm: boolean; pub: boolean }[]>`
      SELECT p.oid::regprocedure::text AS sig, has_function_privilege('yulona_app', p.oid, 'EXECUTE') AS app, has_function_privilege('yulona_admin', p.oid, 'EXECUTE') AS adm,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'sa\\_%'`;
    expect(app.filter((x) => x.app).map((x) => x.sig)).toEqual([]);
    expect(app.filter((x) => x.pub).map((x) => x.sig)).toEqual([]); // not even through PUBLIC
    expect(app.filter((x) => !x.adm).map((x) => x.sig)).toEqual([]);
    // and really, over a real connection
    expect(await outcome(b.db`SELECT sa_overview()`)).toMatch(/permission denied/);
    expect(await outcome(b.db`SELECT * FROM sa_list_tenants_v2(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'name','asc',5,0)`)).toMatch(/permission denied/);
    expect((await ad.db`SELECT sa_overview() AS o`)[0]!.o).toBeTruthy();
  });

  test("the customer API still has the non-sa helpers it needs (impersonation_session_active, tenant_is_active, impersonation_exchange)", async () => {
    const r = await b.owner<{ f: string; ok: boolean }[]>`SELECT p.proname AS f, has_function_privilege('yulona_app', p.oid, 'EXECUTE') AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('impersonation_session_active', 'tenant_is_active', 'impersonation_exchange', 'api_key_resolve', 'invitation_accept')`;
    expect(r.map((x) => x.f).sort()).toEqual(["api_key_resolve", "impersonation_exchange", "impersonation_session_active", "invitation_accept", "tenant_is_active"]);
    expect(r.filter((x) => !x.ok)).toEqual([]);
  });

  test("yulona_admin has no table, view or sequence privileges at all, and cannot read tables over a real connection", async () => {
    const tables = await b.owner<{ t: string }[]>`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')`;
    expect(tables.length).toBeGreaterThan(60);
    const granted: string[] = [];
    for (const { t: name } of tables) {
      const [g] = await b.owner<{ ok: boolean }[]>`SELECT (has_table_privilege('yulona_admin', ${`public."${name}"`}, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        OR has_any_column_privilege('yulona_admin', ${`public."${name}"`}, 'SELECT, INSERT, UPDATE, REFERENCES')) AS ok`;
      if (g!.ok) granted.push(name);
    }
    expect(granted).toEqual([]);
    for (const q of ["SELECT * FROM tenants", "SELECT * FROM platform_admins", "SELECT * FROM users", "SELECT * FROM messages", "SELECT * FROM llm_provider_profiles", "DELETE FROM tenants", "UPDATE platform_admins SET role = 'owner'"]) {
      expect([q, await outcome(ad.db.unsafe(q))].join(" => ")).toMatch(/permission denied/);
    }
    const [r] = await b.owner<{ super: boolean; bypass: boolean; create: boolean }[]>`SELECT rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS create FROM pg_roles WHERE rolname = 'yulona_admin'`;
    expect(r).toEqual({ super: false, bypass: false, create: false });
    expect((await b.owner`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'yulona_admin'`).length).toBe(0);
  });

  test("platform tables are granted to no application role and unreachable from the customer connection", async () => {
    const platform = ["platform_admins", "platform_audit_logs", "admin_sessions", "tenant_notes", "tenant_tags", "impersonation_codes", "impersonation_sessions", "llm_provider_profiles"];
    for (const name of platform) {
      const [g] = await b.owner<{ app: boolean }[]>`SELECT has_table_privilege('yulona_app', ${`public."${name}"`}, 'SELECT, INSERT, UPDATE, DELETE') AS app`;
      expect([name, g!.app]).toEqual([name, false]);
      expect([name, await outcome(b.db.unsafe(`SELECT * FROM ${name}`))].join(" => ")).toMatch(/permission denied/);
    }
  });

  test("impersonation codes: single use, expire after 60 s, stored hashed; the admin API never returns a tenant token", async () => {
    const adm = await ad.admin("owner");
    const r = await ad.call("POST", `/tenants/${t.tenantId}/impersonate`, adm.h, { reason: "support ticket 77", readOnly: false });
    expect(r.status).toBe(201);
    const body = await r.json() as { code: string; sessionId: string; customerUrl: string; accessToken?: string };
    expect(body.accessToken).toBeUndefined();
    expect(body.customerUrl).toBe(`https://app.example.test/impersonate#code=${body.code}`);
    expect(JSON.stringify(await b.owner`SELECT * FROM impersonation_codes`)).not.toContain(body.code);
    const ex = await api(b, "POST", "/auth/impersonation/exchange", {}, { code: body.code });
    expect(ex.status).toBe(200);
    const tok = (await ex.json() as { accessToken: string }).accessToken;
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${tok}` })).status).toBe(200);
    expect((await api(b, "POST", "/auth/impersonation/exchange", {}, { code: body.code })).status).toBe(400); // used
    // expiry
    const r2 = await (await ad.call("POST", `/tenants/${t.tenantId}/impersonate`, adm.h, { reason: "support ticket 78" })).json() as { code: string; sessionId: string };
    await b.owner`UPDATE impersonation_codes SET expires_at = now() - interval '1 second' WHERE code_hash = ${sha256(r2.code)}`;
    expect((await api(b, "POST", "/auth/impersonation/exchange", {}, { code: r2.code })).status).toBe(400);
    // ending from the admin side kills the live token at once
    expect((await ad.call("POST", `/impersonation/${body.sessionId}/end`, adm.h)).status).toBe(200);
    expect((await api(b, "GET", "/me", { authorization: `Bearer ${tok}` })).status).toBe(401);
  });

  test("the read-only flag set by the admin API reaches the customer token", async () => {
    const sup = await ad.admin("support");
    const s = await (await ad.call("POST", `/tenants/${t.tenantId}/impersonate`, sup.h, { reason: "support ticket 79" })).json() as { code: string; readOnly: boolean };
    expect(s.readOnly).toBe(true);
    const x = await (await api(b, "POST", "/auth/impersonation/exchange", {}, { code: s.code })).json() as { accessToken: string; readOnly: boolean };
    expect(x.readOnly).toBe(true);
    const h = { authorization: `Bearer ${x.accessToken}` };
    expect((await api(b, "GET", "/agents", h)).status).toBe(200);
    expect((await api(b, "POST", "/agents", h, { name: "nope" })).status).toBe(403);
  });
});
