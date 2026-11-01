import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, bootAdminOn, boot, hasDb, jsonOf, mkTenant, PASSWORD, type AdminBooted, type Booted } from "../support";

/** Cross-product behaviour: what the platform-admin API changes is what the customer product enforces. */
describe.skipIf(!hasDb)("admin platform -> customer product", () => {
  let b: Booted, ad: AdminBooted;
  beforeAll(async () => { b = await boot(); ad = await bootAdminOn(b); });
  afterAll(async () => { await ad.close(); await b.close(); });

  const login = async (email: string, password = PASSWORD) => {
    const r = await api(b, "POST", "/auth/login", {}, { email, password });
    return r.status === 200 ? (await jsonOf<{ accessToken: string }>(r)).accessToken : null;
  };

  test("create, suspend, unsuspend, delete, restore and purge a customer: logins and live tokens follow at once", async () => {
    const o = await ad.admin("owner");
    const email = `created-${crypto.randomUUID().slice(0, 8)}@customer.example.test`;
    const cr = await ad.call("POST", "/tenants", o.h, { name: "Created Co", plan: "pro", ownerEmail: email, ownerName: "O", ownerPassword: PASSWORD });
    expect(cr.status).toBe(201);
    const { id } = await jsonOf<{ id: string }>(cr);
    const tok = (await login(email))!;
    expect(tok).toBeTruthy();
    const h = { authorization: `Bearer ${tok}` };
    expect((await api(b, "GET", "/me", h)).status).toBe(200);

    expect((await ad.call("POST", `/tenants/${id}/suspend`, o.h)).status).toBe(200);
    expect(await login(email)).toBeNull();
    expect((await api(b, "GET", "/me", h)).status).toBe(401); // the live access token dies immediately too
    expect((await ad.call("POST", `/tenants/${id}/unsuspend`, o.h)).status).toBe(200);
    expect(await login(email)).toBeTruthy();
    expect((await ad.call("DELETE", `/tenants/${id}`, o.h)).status).toBe(200);
    expect(await login(email)).toBeNull();
    expect((await ad.call("POST", `/tenants/${id}/restore`, o.h)).status).toBe(200);
    expect(await login(email)).toBeTruthy();
    expect((await b.owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${id} AND action = 'tenant.status.suspended'`).length).toBe(1);

    // notes and tags exist; a soft delete + 30 days => hard delete including everything tied to the tenant
    await ad.call("POST", `/tenants/${id}/notes`, o.h, { body: "to be purged" });
    await ad.call("PUT", `/tenants/${id}/tags`, o.h, { tags: ["purge-me"] });
    await ad.call("DELETE", `/tenants/${id}`, o.h);
    const { purgeDeletedTenants } = await import("../../apps/worker/src/maintenance");
    await purgeDeletedTenants(b.db);
    expect((await b.owner`SELECT 1 FROM tenants WHERE id = ${id}`).length).toBe(1); // not old enough
    await b.owner`UPDATE tenants SET deleted_at = now() - interval '31 days' WHERE id = ${id}`;
    expect((await ad.call("POST", `/tenants/${id}/restore`, o.h)).status).toBe(409);
    expect(await purgeDeletedTenants(b.db)).toBeGreaterThanOrEqual(1);
    for (const t of ["tenants", "users", "audit_logs", "tenant_notes", "tenant_tags"]) {
      const col = t === "tenants" ? "id" : "tenant_id";
      expect([t, (await b.owner.unsafe(`SELECT 1 FROM ${t} WHERE ${col} = '${id}'`)).length]).toEqual([t, 0]);
    }
  });

  test("flag overrides, plan changes, plan limits, credit grants and credit packs reach the customer product", async () => {
    const o = await ad.admin("owner");
    const t = await mkTenant(b, "eff", "owner");
    await b.owner`UPDATE tenants SET plan_key = 'pro' WHERE id = ${t.tenantId}`;
    const key = `flag.${crypto.randomUUID().slice(0, 8)}`;
    await ad.call("PUT", `/feature-flags/${key}`, o.h, { description: "d", defaultEnabled: false });
    const eff = async () => ((await (await api(b, "GET", "/feature-flags", t.h)).json()) as { flags: Record<string, boolean> }).flags[key];
    expect(await eff()).toBe(false);
    await ad.call("PUT", `/tenants/${t.tenantId}/flags/${key}`, o.h, { enabled: true });
    expect(await eff()).toBe(true);
    await ad.call("DELETE", `/feature-flags/${key}`, o.h);

    expect((await jsonOf(await api(b, "GET", "/tenant", t.h))).plan.key).toBe("pro");
    expect((await ad.call("PUT", `/tenants/${t.tenantId}/plan`, o.h, { plan: "free" })).status).toBe(200);
    expect((await jsonOf(await api(b, "GET", "/tenant", t.h))).plan.key).toBe("free");
    expect((await ad.call("PUT", `/tenants/${t.tenantId}/plan`, o.h, { plan: "pro" })).status).toBe(200);

    // plan credit limit
    const allowance = async () => (await jsonOf(await api(b, "GET", "/usage/credits", t.h))).allowanceMicro;
    const before = await allowance();
    expect((await ad.call("PUT", "/plans/pro/limits/llm_credits_monthly", o.h, { limit: 2000 })).status).toBe(200);
    expect(await allowance()).toBe(2000 * 1_000_000);
    expect((await ad.call("PUT", "/plans/pro/limits/llm_credits_monthly", o.h, { limit: before / 1_000_000 })).status).toBe(200);
    expect(await allowance()).toBe(before);

    // grants
    const g = await ad.call("POST", `/tenants/${t.tenantId}/credits`, o.h, { credits: 100.5, reason: "Goodwill after outage" });
    expect(g.status).toBe(200);
    expect((await jsonOf(await api(b, "GET", "/usage/credits", t.h))).topupMicro).toBe(100_500_000);
    expect((await b.owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'billing.credits_adjusted'`).length).toBe(1);
    expect((await b.owner`SELECT 1 FROM notifications WHERE tenant_id = ${t.tenantId} AND type = 'credits.granted'`).length).toBe(1);
    await b.owner`UPDATE notifications SET email_status = 'none' WHERE type LIKE 'credits.%' AND email_status = 'pending'`; // do not crowd other suites' email batches

    // packs: an inactive pack disappears for customers and cannot be bought
    const pack = await jsonOf(await ad.call("POST", "/credit-packs", o.h, { name: `Promo ${crypto.randomUUID().slice(0, 4)}`, credits: 100, priceCents: 500 }));
    const packIds = async () => (await jsonOf(await api(b, "GET", "/billing/credit-packs", t.h))).items.map((p: { id: string }) => p.id);
    expect(await packIds()).toContain(pack.id);
    await ad.call("PATCH", `/credit-packs/${pack.id}`, o.h, { active: false });
    expect(await packIds()).not.toContain(pack.id);
    expect((await api(b, "POST", "/billing/credits/checkout", t.h, { packId: pack.id })).status).toBe(404);
    await ad.call("DELETE", `/credit-packs/${pack.id}`, o.h);
  });

  test("a dead job retried from the admin API is claimable again by the worker queue", async () => {
    const o = await ad.admin("support");
    const t = await mkTenant(b, "dj");
    const [j] = await b.owner<{ id: string }[]>`INSERT INTO jobs (tenant_id, name, status, attempts, last_error) VALUES (${t.tenantId}, 'channel.send', 'dead', 5, 'x') RETURNING id`;
    expect((await ad.call("POST", `/ops/dead-jobs/${j!.id}/retry`, o.h)).status).toBe(200);
    const claimed = await b.owner<{ id: string }[]>`SELECT id FROM jobs_claim('test-worker', ARRAY['channel.send'], 50, 60) WHERE id = ${j!.id}`;
    expect(claimed.map((c) => c.id)).toEqual([j!.id]);
  });
});
