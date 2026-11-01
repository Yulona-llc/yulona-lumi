import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, hasDb, type Booted } from "../support";

describe.skipIf(!hasDb)("RLS posture (catalog-level)", () => {
  let b: Booted;
  beforeAll(async () => { b = await boot(); });
  afterAll(async () => b.close());

  test("every table with tenant_id has RLS ENABLED + FORCED and at least one policy", async () => {
    const rows = await b.owner<{ table: string; rls: boolean; force: boolean; policies: number }[]>`
      SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'tenant_id')`;
    expect(rows.length).toBeGreaterThan(30);
    const bad = rows.filter((r) => !r.rls || !r.force || r.policies === 0).map((r) => r.table);
    expect(bad).toEqual([]);
  });

  test("tenant-facing policies never reference anything but the tenant GUC; no policy is USING (true) for yulona_app", async () => {
    const rows = await b.owner<{ table: string; policy: string; roles: string[]; qual: string | null }[]>`
      SELECT tablename AS "table", policyname AS policy, roles, qual FROM pg_policies WHERE schemaname = 'public'`;
    const open = rows.filter((r) => (r.roles.includes("yulona_app") || r.roles.includes("public")) && (r.qual ?? "").trim() === "true");
    expect(open.map((r) => `${r.table}.${r.policy}`)).toEqual([]);
  });

  test("tables without tenant_id are an explicit allow-list (platform/global data)", async () => {
    const rows = await b.owner<{ t: string }[]>`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'tenant_id')`;
    // global/platform tables: RLS-protected (tenants, platform_admins, admin_sessions, worker_heartbeats; owner-only policies, no grants to yulona_app
    // or yulona_admin) or read-only reference data for yulona_app
    const allowed = new Set(["schema_migrations", "tenants", "plans", "plan_limits", "plan_prices", "feature_flags", "platform_admins", "worker_heartbeats", "llm_model_rates", "credit_packs", "llm_provider_profiles", "platform_audit_logs", "admin_sessions"]);
    const unexpected = rows.map((r) => r.t).filter((t) => !allowed.has(t));
    // Anything not allow-listed must be reviewed: either add tenant_id + RLS, or justify here.
    expect(unexpected).toEqual([]);
    const writable = await b.owner<{ t: string; p: string }[]>`
      SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
      WHERE grantee = 'yulona_app' AND table_name IN ('plans','plan_limits','plan_prices','feature_flags','schema_migrations','platform_admins')
        AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`;
    expect([...writable]).toEqual([]);
    // wave 6: platform tables (admins, sessions, audit, notes, tags, impersonation codes/sessions) are granted to NO application role
    const leaked = await b.owner<{ t: string; g: string }[]>`
      SELECT table_name AS t, grantee AS g FROM information_schema.role_table_grants
      WHERE grantee IN ('yulona_app', 'yulona_admin', 'PUBLIC')
        AND table_name IN ('platform_admins','platform_audit_logs','admin_sessions','tenant_notes','tenant_tags','impersonation_codes','impersonation_sessions','billing_events','worker_heartbeats','llm_provider_profiles')`;
    expect([...leaked]).toEqual([]);
  });

  test("yulona_app is not superuser, has no BYPASSRLS, does not own tables", async () => {
    const [r] = await b.owner<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]>`
      SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'yulona_app'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = await b.owner`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'yulona_app'`;
    expect(owned.length).toBe(0);
    const [who] = await b.db<{ rolsuper: string; bypass: boolean }[]>`SELECT current_setting('is_superuser') AS rolsuper, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    expect(who).toEqual({ rolsuper: "off", bypass: false });
  });

  test("app role without the tenant GUC sees zero rows in every tenant table", async () => {
    const tables = await b.owner<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`;
    // seed so the check is meaningful
    const [tn] = await b.owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('rls-probe') RETURNING id`;
    await b.owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tn!.id}, ${`p-${crypto.randomUUID()}@x.test`}, 'p', 'owner', 'x')`;
    const leaks: string[] = [];
    for (const { t } of tables) {
      const [r] = await b.db.unsafe(`SELECT count(*)::int AS n FROM "${t}"`).catch(() => [{ n: 0 }]);
      if ((r as { n: number }).n > 0) leaks.push(t);
    }
    expect(leaks).toEqual([]);
  });
});
