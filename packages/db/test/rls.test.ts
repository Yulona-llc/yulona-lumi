import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb, testUrls } from "../src/testing";
import { AuditLogRepository, UsersRepository, withTenant, createPreauth, type Db } from "../src";
import type postgres from "postgres";

if (!testUrls()) console.warn(SKIP_MESSAGE);

describe.skipIf(!testUrls())("RLS as the non-bypass app role", () => {
  let owner: postgres.Sql, app: Db;
  let A: Awaited<ReturnType<typeof seedTenantWithUser>>, B: typeof A;

  beforeAll(async () => {
    ({ owner, app } = await setupTestDb());
    A = await seedTenantWithUser(owner, "a");
    B = await seedTenantWithUser(owner, "b");
  });
  afterAll(async () => {
    await app.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });

  test("app role is not superuser / bypassrls", async () => {
    const [r] = await app<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(r!.rolsuper).toBe(false);
    expect(r!.rolbypassrls).toBe(false);
  });

  test("no GUC => zero rows", async () => {
    expect((await app`SELECT id FROM users`).length).toBe(0);
    expect((await app`SELECT id FROM tenants`).length).toBe(0);
  });

  test("tenant A sees only its own rows", async () => {
    const rows = await withTenant(app, A.tenantId, (tx) => tx<{ id: string; tenantId: string }[]>`SELECT id, tenant_id FROM users`);
    expect(rows.map((r) => r.id)).toEqual([A.userId]);
    const viaRepo = await withTenant(app, A.tenantId, (tx) => new UsersRepository(tx, A.tenantId).findById(B.userId));
    expect(viaRepo).toBeUndefined();
  });

  test("GUC does not leak across transactions on pooled connections", async () => {
    await withTenant(app, A.tenantId, async (tx) => void (await tx`SELECT 1`));
    expect((await app`SELECT id FROM users`).length).toBe(0);
  });

  test("insert with another tenant's id is rejected", async () => {
    await expect(
      withTenant(app, A.tenantId, (tx) =>
        tx`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${B.tenantId}, 'evil@example.test', 'x', 'agent', 'x')`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(app, A.tenantId, (tx) => new AuditLogRepository(tx, B.tenantId).record({ action: "x" })),
    ).rejects.toThrow(/row-level security/);
  });

  test("cross-tenant update/delete affects nothing", async () => {
    const upd = await withTenant(app, A.tenantId, (tx) => tx`UPDATE users SET name = 'pwned' WHERE id = ${B.userId}`);
    expect(upd.count).toBe(0);
    const [still] = await owner`SELECT name FROM users WHERE id = ${B.userId}`;
    expect(still!.name).toBe("b");
    await expect(withTenant(app, A.tenantId, (tx) => tx`DELETE FROM users WHERE id = ${A.userId}`)).rejects.toThrow(/permission denied/);
  });

  test("audit_logs is append-only and app cannot create tenants", async () => {
    await withTenant(app, A.tenantId, (tx) => new AuditLogRepository(tx, A.tenantId).record({ action: "t.ok", metadata: { password: "x" } }));
    await expect(withTenant(app, A.tenantId, (tx) => tx`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
    await expect((async () => { await app`INSERT INTO tenants (name) VALUES ('x')`; })()).rejects.toThrow();
  });

  test("invalid tenant id never reaches SQL", async () => {
    await expect(withTenant(app, "x' OR '1'='1", async () => 1)).rejects.toThrow(/invalid tenantId/);
  });

  test("pre-auth path: register, lookup, rotation, reuse detection", async () => {
    const pre = createPreauth(app);
    const email = `pre-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { tenantId, userId } = await pre.register({ workspaceName: "W", email, passwordHash: "h", name: "N" });
    const u = await pre.findUserByEmail(email.toUpperCase());
    expect(u?.userId).toBe(userId);
    expect(u?.tenantId).toBe(tenantId);

    const fam = crypto.randomUUID();
    await withTenant(app, tenantId, (tx) =>
      tx`INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at)
         VALUES (${tenantId}, ${userId}, ${fam}, ${`h1-${fam}`}, now() + interval '1 day')`);
    const r1 = await pre.rotateRefresh({ oldHash: `h1-${fam}`, newHash: `h2-${fam}`, expiresAt: new Date(Date.now() + 86_400_000) });
    expect(r1.status).toBe("ok");
    const r2 = await pre.rotateRefresh({ oldHash: `h1-${fam}`, newHash: `h3-${fam}`, expiresAt: new Date(Date.now() + 86_400_000) });
    expect(r2.status).toBe("reuse");
    const r3 = await pre.rotateRefresh({ oldHash: `h2-${fam}`, newHash: `h4-${fam}`, expiresAt: new Date(Date.now() + 86_400_000) });
    expect(r3.status).toBe("invalid"); // family revoked
  });

  test("app role cannot read other tenants through raw access to definer-only data", async () => {
    // password hashes are reachable only through the narrow function, by exact email
    const pre = createPreauth(app);
    expect(await pre.findUserByEmail("nobody@example.test")).toBeUndefined();
  });
});
