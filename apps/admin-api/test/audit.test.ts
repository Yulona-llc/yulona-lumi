import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, mkTenant, type AdminBoot, type TestAdmin } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("platform audit log: filters and exports", () => {
  let b: AdminBoot, owner: TestAdmin, support: TestAdmin, billing: TestAdmin;
  let t1: Awaited<ReturnType<typeof mkTenant>>, t2: Awaited<ReturnType<typeof mkTenant>>;
  beforeAll(async () => {
    b = await bootAdmin();
    owner = await mkAdmin(b, "owner"); support = await mkAdmin(b, "support"); billing = await mkAdmin(b, "billing");
    t1 = await mkTenant(b); t2 = await mkTenant(b);
    await call(b, "POST", `/tenants/${t1.tenantId}/notes`, support, { body: "note one" });
    await call(b, "PUT", `/tenants/${t1.tenantId}/tags`, support, { tags: ["vip"] });
    await call(b, "POST", `/tenants/${t2.tenantId}/credits`, billing, { credits: 5, reason: "goodwill gift" });
    await call(b, "POST", `/tenants/${t2.tenantId}/suspend`, owner);
  });
  afterAll(async () => b.close());

  const list = async (qs: string, who: TestAdmin = billing) => jsonOf(await call(b, "GET", `/audit-logs?${qs}`, who));

  test("filter by admin, tenant, exact action, action prefix and dates; totals honour the filters", async () => {
    const byAdmin = await list(`adminId=${support.id}&limit=200`);
    expect(byAdmin.items.map((x: { action: string }) => x.action).sort()).toEqual(["tenant.note.add", "tenant.tags"]);
    expect(byAdmin.items[0]).toMatchObject({ adminId: support.id, adminEmail: support.email });
    expect(byAdmin.total).toBe(2);
    const byTenant = await list(`tenantId=${t2.tenantId}&limit=200`);
    expect(byTenant.items.map((x: { action: string }) => x.action).sort()).toEqual(["credits.grant", "tenant.status.suspended"]);
    expect(byTenant.items[0].tenantName).toBe(t2.name);
    expect((await list(`tenantId=${t1.tenantId}&action=tenant.tags`)).total).toBe(1);
    const prefix = await list(`tenantId=${t1.tenantId}&action=${encodeURIComponent("tenant.note.")}`);
    expect(prefix.items.map((x: { action: string }) => x.action)).toEqual(["tenant.note.add"]);
    expect((await list(`tenantId=${t1.tenantId}&action=tenant`)).total).toBe(0); // no implicit prefix without the trailing dot
    expect((await list(`action=${encodeURIComponent("tenant._")}`)).total).toBe(0); // wildcards in prefixes are literal
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await list(`tenantId=${t1.tenantId}&from=${future}`)).total).toBe(0);
    expect((await list(`tenantId=${t1.tenantId}&to=${past}`)).total).toBe(0);
    expect((await list(`tenantId=${t1.tenantId}&from=${past}&to=${future}`)).total).toBe(2);
    expect((await list(`tenantId=${t1.tenantId}&limit=1&offset=0`)).total).toBe(2);
    expect((await list(`tenantId=${t1.tenantId}&limit=1&offset=5`)).total).toBe(2);
    expect((await call(b, "GET", "/audit-logs?adminId=nope", billing)).status).toBe(400);
    expect((await call(b, "GET", "/audit-logs?from=yesterday", billing)).status).toBe(400);
  });

  test("login, logout and 2FA events are recorded", async () => {
    const a = await mkAdmin(b, "support", { password: "correct horse battery staple" });
    await b.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: a.email, password: "correct horse battery staple" }) });
    const r = await list(`adminId=${a.id}&action=${encodeURIComponent("admin.")}`);
    expect(r.items.map((x: { action: string }) => x.action)).toEqual(["admin.login"]);
  });

  test("export: owner only, csv and json, filtered, injection-safe, itself audited", async () => {
    for (const who of [support, billing]) expect((await call(b, "GET", "/audit-logs/export", who)).status).toBe(403);
    const csv = await call(b, "GET", `/audit-logs/export?tenantId=${t1.tenantId}`, owner);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("platform-audit-");
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines[0]).toBe("id,createdAt,adminId,adminEmail,action,tenantId,tenantName,metadata");
    expect(lines).toHaveLength(3);
    await b.owner`INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (${owner.id}, '=cmd|calc', ${t1.tenantId}, '{}'::jsonb)`;
    expect(await (await call(b, "GET", `/audit-logs/export?tenantId=${t1.tenantId}`, owner)).text()).toContain("'=cmd|calc");
    const js = await jsonOf(await call(b, "GET", `/audit-logs/export?format=json&adminId=${support.id}`, owner));
    expect(js.items).toHaveLength(2);
    expect((await call(b, "GET", "/audit-logs/export?format=xml", owner)).status).toBe(400);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${owner.id} AND action = 'audit.export'`).length).toBe(3);
  });
});
