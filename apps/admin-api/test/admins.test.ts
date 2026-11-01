import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, uniq, type AdminBoot } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("admin management (owner only)", () => {
  let b: AdminBoot;
  beforeAll(async () => { b = await bootAdmin(); });
  afterAll(async () => b.close());

  /** Make `who` the only active owner (other test admins are disabled) so last-owner rules can be exercised. */
  async function soleOwner() {
    await b.owner`UPDATE platform_admins SET status = 'disabled' WHERE role = 'owner'`;
    return mkAdmin(b, "owner");
  }
  const login = (email: string, password: string) =>
    b.app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });

  test("support and billing cannot touch admin management", async () => {
    const o = await mkAdmin(b, "owner"), s = await mkAdmin(b, "support"), bl = await mkAdmin(b, "billing");
    for (const who of [s, bl]) {
      expect((await call(b, "GET", "/admins", who)).status).toBe(403);
      expect((await call(b, "POST", "/admins", who, { email: "x@admin.example.test", name: "X", role: "owner" })).status).toBe(403);
      expect((await call(b, "PATCH", `/admins/${o.id}`, who, { role: "support" })).status).toBe(403);
      expect((await call(b, "POST", `/admins/${o.id}/deactivate`, who)).status).toBe(403);
      expect((await call(b, "POST", `/admins/${o.id}/reset-2fa`, who)).status).toBe(403);
      expect((await call(b, "POST", `/admins/${o.id}/reset-password`, who)).status).toBe(403);
    }
  });

  test("invite: temporary password shown once, forced change at first login, list shows state", async () => {
    const o = await mkAdmin(b, "owner");
    const email = `${uniq("new")}@admin.example.test`;
    expect((await call(b, "POST", "/admins", o, { email, name: "New Support", role: "root" })).status).toBe(400);
    expect((await call(b, "POST", "/admins", o, { email, name: "New Support", role: "support", x: 1 })).status).toBe(400);
    const r = await call(b, "POST", "/admins", o, { email, name: "New Support", role: "support" });
    expect(r.status).toBe(201);
    const inv = await jsonOf(r);
    expect(inv).toMatchObject({ email, role: "support" });
    expect(inv.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    expect((await call(b, "POST", "/admins", o, { email: email.toUpperCase(), name: "Dup", role: "support" })).status).toBe(409);
    const [stored] = await b.owner<{ password_hash: string; must_change_password: boolean }[]>`SELECT password_hash, must_change_password FROM platform_admins WHERE id = ${inv.id}`;
    expect(stored!.must_change_password).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(inv.temporaryPassword);
    const l = await jsonOf(await login(email, inv.temporaryPassword));
    expect(l.admin).toMatchObject({ role: "support", restricted: "password_change" });
    const list = await jsonOf(await call(b, "GET", "/admins", o));
    expect(list.items.find((x: { id: string }) => x.id === inv.id)).toMatchObject({ email, name: "New Support", role: "support", status: "active", twoFactorEnabled: false });
    expect(JSON.stringify(list)).not.toContain("password");
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${o.id} AND action = 'admin.create'`).length).toBeGreaterThanOrEqual(1);
  });

  test("role changes apply immediately (the role is re-read on every request)", async () => {
    const o = await mkAdmin(b, "owner"), s = await mkAdmin(b, "support");
    expect((await call(b, "POST", `/tenants/${crypto.randomUUID()}/notes`, s, { body: "x" })).status).toBe(404); // allowed
    expect((await jsonOf(await call(b, "PATCH", `/admins/${s.id}`, o, { role: "billing" }))).role).toBe("billing");
    expect((await call(b, "POST", `/tenants/${crypto.randomUUID()}/notes`, s, { body: "x" })).status).toBe(403); // same token, new role
    expect((await jsonOf(await call(b, "PATCH", `/admins/${s.id}`, o, { name: "Renamed" }))).name).toBe("Renamed");
    expect((await call(b, "PATCH", `/admins/${s.id}`, o, {})).status).toBe(400);
    expect((await call(b, "PATCH", `/admins/${crypto.randomUUID()}`, o, { role: "owner" })).status).toBe(404);
  });

  test("last owner protection: cannot demote or deactivate the only active owner; self-deactivation refused", async () => {
    const o = await soleOwner();
    expect((await call(b, "PATCH", `/admins/${o.id}`, o, { role: "support" })).status).toBe(409);
    expect((await call(b, "POST", `/admins/${o.id}/deactivate`, o)).status).toBe(409);
    expect((await jsonOf(await call(b, "GET", "/admins", o))).items.find((x: { id: string }) => x.id === o.id)).toMatchObject({ role: "owner", status: "active" });
    // a second owner lifts the protection; deactivating oneself is still refused
    const o2 = await mkAdmin(b, "owner");
    expect((await call(b, "POST", `/admins/${o.id}/deactivate`, o)).status).toBe(409);
    expect((await call(b, "PATCH", `/admins/${o.id}`, o2, { role: "support" })).status).toBe(200);
    expect((await call(b, "PATCH", `/admins/${o2.id}`, o2, { role: "billing" })).status).toBe(409); // o2 is now the last owner
    expect((await call(b, "POST", `/admins/${o2.id}/deactivate`, o2)).status).toBe(409);
    // a disabled owner does not count as an owner
    const o3 = await mkAdmin(b, "owner");
    await call(b, "POST", `/admins/${o3.id}/deactivate`, o2);
    expect((await call(b, "PATCH", `/admins/${o2.id}`, o2, { role: "billing" })).status).toBe(409);
    expect((await call(b, "POST", `/admins/${o3.id}/activate`, o2)).status).toBe(200);
    expect((await call(b, "PATCH", `/admins/${o2.id}`, o2, { role: "billing" })).status).toBe(200);
  });

  test("deactivate / activate", async () => {
    const o = await mkAdmin(b, "owner"), s = await mkAdmin(b, "support");
    expect((await jsonOf(await call(b, "POST", `/admins/${s.id}/deactivate`, o))).status).toBe("disabled");
    expect((await call(b, "GET", "/auth/me", s)).status).toBe(401);
    expect((await jsonOf(await call(b, "POST", `/admins/${s.id}/activate`, o))).status).toBe("active");
    expect((await call(b, "POST", `/admins/${crypto.randomUUID()}/deactivate`, o)).status).toBe(404);
    expect((await call(b, "POST", `/admins/${crypto.randomUUID()}/activate`, o)).status).toBe(404);
  });

  test("reset 2FA clears the factor and sessions; reset password issues a new temporary password and forces a change", async () => {
    const o = await mkAdmin(b, "owner"), s = await mkAdmin(b, "support", { password: "correct horse battery staple" });
    await b.owner`UPDATE platform_admins SET totp_secret_encrypted = 'v1.x', totp_enabled_at = now(), totp_recovery_hashes = ARRAY['aa','bb'] WHERE id = ${s.id}`;
    expect((await jsonOf(await call(b, "GET", "/admins", o))).items.find((x: { id: string }) => x.id === s.id).twoFactorEnabled).toBe(true);
    const r = await jsonOf(await call(b, "POST", `/admins/${s.id}/reset-2fa`, o));
    expect(r).toMatchObject({ id: s.id, twoFactorEnabled: false });
    const [row] = await b.owner<{ totp_secret_encrypted: string | null; totp_recovery_hashes: string[] }[]>`SELECT totp_secret_encrypted, totp_recovery_hashes FROM platform_admins WHERE id = ${s.id}`;
    expect(row).toEqual({ totp_secret_encrypted: null, totp_recovery_hashes: [] });
    expect((await call(b, "GET", "/auth/me", s)).status).toBe(401); // sessions revoked
    const pw = await jsonOf(await call(b, "POST", `/admins/${s.id}/reset-password`, o));
    expect(pw.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    expect((await login(s.email, "correct horse battery staple")).status).toBe(401);
    expect((await jsonOf(await login(s.email, pw.temporaryPassword))).admin.restricted).toBe("password_change");
    expect((await call(b, "POST", `/admins/${crypto.randomUUID()}/reset-2fa`, o)).status).toBe(404);
    expect((await call(b, "POST", `/admins/${crypto.randomUUID()}/reset-password`, o)).status).toBe(404);
    const acts = (await b.owner<{ action: string }[]>`SELECT action FROM platform_audit_logs WHERE admin_id = ${o.id}`).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["admin.2fa.reset", "admin.reset_password", "admin.deactivate"].slice(0, 2)));
  });
});
