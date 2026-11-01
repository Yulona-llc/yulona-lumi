import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { sha256 } from "../src/security";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, mkTenant, uniq, type AdminBoot, type TestAdmin } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("support tools", () => {
  let b: AdminBoot;
  let owner: TestAdmin, support: TestAdmin, billing: TestAdmin;
  beforeAll(async () => {
    b = await bootAdmin();
    owner = await mkAdmin(b, "owner"); support = await mkAdmin(b, "support"); billing = await mkAdmin(b, "billing");
  });
  afterAll(async () => b.close());

  test("notes: support and owner write, billing cannot; support deletes only its own, owner any; audited without the text", async () => {
    const t = await mkTenant(b);
    const base = `/tenants/${t.tenantId}/notes`;
    expect((await call(b, "POST", base, billing, { body: "x" })).status).toBe(403);
    expect((await call(b, "POST", base, support, { body: "" })).status).toBe(400);
    expect((await call(b, "POST", base, support, { body: "x".repeat(2001) })).status).toBe(400);
    expect((await call(b, "POST", base, support, { body: "ok", extra: 1 })).status).toBe(400);
    const n1 = await jsonOf(await call(b, "POST", base, support, { body: "Customer asked for a call back" }));
    expect(n1).toMatchObject({ body: "Customer asked for a call back", adminEmail: support.email, adminId: support.id });
    const n2 = await jsonOf(await call(b, "POST", base, owner, { body: "Owner note" }));
    expect((await call(b, "POST", `/tenants/${crypto.randomUUID()}/notes`, support, { body: "x" })).status).toBe(404);
    const list = await jsonOf(await call(b, "GET", base, billing)); // everyone can read
    expect(list.items.map((n: { body: string }) => n.body)).toEqual(["Owner note", "Customer asked for a call back"]);
    expect((await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}`, billing))).notesCount).toBe(2);
    expect((await call(b, "DELETE", `${base}/${n2.id}`, support)).status).toBe(404); // not its own
    expect((await call(b, "DELETE", `${base}/${n1.id}`, support)).status).toBe(200);
    expect((await call(b, "DELETE", `${base}/${n2.id}`, owner)).status).toBe(200);
    expect((await call(b, "DELETE", `${base}/${n2.id}`, owner)).status).toBe(404);
    const aud = await b.owner<{ metadata: unknown }[]>`SELECT metadata FROM platform_audit_logs WHERE tenant_id = ${t.tenantId} AND action LIKE 'tenant.note.%'`;
    expect(aud).toHaveLength(4);
    expect(JSON.stringify(aud)).not.toContain("call back");
  });

  test("tags: validation, replace, list with counts, bulk add/remove, filter", async () => {
    const t1 = await mkTenant(b), t2 = await mkTenant(b);
    const tag = uniq("tg").toLowerCase();
    expect((await call(b, "PUT", `/tenants/${t1.tenantId}/tags`, billing, { tags: [tag] })).status).toBe(403);
    for (const bad of [["Bad Tag"], ["-lead"], ["x".repeat(31)], Array.from({ length: 21 }, (_, i) => `t${i}`)]) {
      expect((await call(b, "PUT", `/tenants/${t1.tenantId}/tags`, support, { tags: bad })).status).toBe(400);
    }
    expect(await jsonOf(await call(b, "PUT", `/tenants/${t1.tenantId}/tags`, support, { tags: [tag, "vip", "vip"] }))).toEqual({ tags: [tag, "vip"] });
    expect((await jsonOf(await call(b, "GET", `/tenants/${t1.tenantId}/tags`, billing))).tags).toEqual([tag, "vip"].sort());
    expect((await call(b, "PUT", `/tenants/${crypto.randomUUID()}/tags`, support, { tags: [] })).status).toBe(404);
    const bulk = await jsonOf(await call(b, "POST", "/tenants/tags/bulk", support, { tenantIds: [t1.tenantId, t2.tenantId, crypto.randomUUID()], add: [tag, "bulk"], remove: ["vip"] }));
    expect(bulk.updated).toBe(2);
    expect((await jsonOf(await call(b, "GET", `/tenants/${t1.tenantId}/tags`, owner))).tags).toEqual([tag, "bulk"].sort());
    const counts = await jsonOf(await call(b, "GET", "/tags", billing));
    expect(counts.items.find((x: { tag: string }) => x.tag === tag).count).toBe(2);
    const filtered = await jsonOf(await call(b, "GET", `/tenants?tag=${tag}`, billing));
    expect(filtered.items.map((x: { id: string }) => x.id).sort()).toEqual([t1.tenantId, t2.tenantId].sort());
    expect(filtered.items[0].tags).toContain(tag);
    expect((await call(b, "POST", "/tenants/tags/bulk", support, { tenantIds: [t1.tenantId] })).status).toBe(400);
    expect((await call(b, "POST", "/tenants/tags/bulk", support, { tenantIds: [], add: [tag] })).status).toBe(400);
    expect((await call(b, "POST", "/tenants/tags/bulk", billing, { tenantIds: [t1.tenantId], add: [tag] })).status).toBe(403);
    await call(b, "PUT", `/tenants/${t1.tenantId}/tags`, support, { tags: [] });
    expect((await jsonOf(await call(b, "GET", `/tenants/${t1.tenantId}/tags`, owner))).tags).toEqual([]);
  });

  test("invitation resend: new token replaces the old, mailed to the invitee, never returned; only pending invitations", async () => {
    const t = await mkTenant(b);
    const oldHash = uniq("old");
    const [inv] = await b.owner<{ id: string }[]>`INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at) VALUES (${t.tenantId}, 'new.hire@customer.example.test', 'agent', ${oldHash}, now() + interval '1 hour') RETURNING id`;
    const url = `/tenants/${t.tenantId}/invitations/${inv!.id}/resend`;
    expect((await call(b, "POST", url, billing)).status).toBe(403);
    const before = b.email.sent.length;
    const r = await call(b, "POST", url, support);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true, emailSent: true });
    expect(b.email.sent).toHaveLength(before + 1);
    const mail = b.email.sent.at(-1)!;
    expect(mail.to).toBe("new.hire@customer.example.test");
    const token = new URL(/https?:\/\/\S+/.exec(mail.text ?? "")![0]).searchParams.get("token")!;
    expect(mail.text).toContain("https://app.example.test/accept-invite?token=");
    expect(text).not.toContain(token);
    const [row] = await b.owner<{ token_hash: string; expires_at: Date }[]>`SELECT token_hash, expires_at FROM invitations WHERE id = ${inv!.id}`;
    expect(row!.token_hash).toBe(sha256(token));
    expect(row!.token_hash).not.toBe(oldHash);
    expect(row!.expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await b.owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'invitation.resent_by_platform'`).length).toBe(1);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'tenant.invitation_resend'`).length).toBe(1);
    await b.owner`UPDATE invitations SET accepted_at = now() WHERE id = ${inv!.id}`;
    expect((await call(b, "POST", url, support)).status).toBe(404); // accepted
    // another tenant's id with this invitation id is not found
    const other = await mkTenant(b);
    expect((await call(b, "POST", `/tenants/${other.tenantId}/invitations/${inv!.id}/resend`, support)).status).toBe(404);
  });

  test("impersonation: read-only by default; write mode owner only; billing never; code is hashed, single use, 60 s", async () => {
    const t = await mkTenant(b);
    const url = `/tenants/${t.tenantId}/impersonate`;
    expect((await call(b, "POST", url, billing, { reason: "support ticket 42" })).status).toBe(403);
    expect((await call(b, "POST", url, support, { reason: "x" })).status).toBe(400);
    expect((await call(b, "POST", url, support, { reason: "support ticket 42", readOnly: false })).status).toBe(403);
    expect((await call(b, "POST", url, support, { reason: "support ticket 42", userId: crypto.randomUUID() })).status).toBe(404);
    const res = await call(b, "POST", url, support, { reason: "support ticket 42" });
    expect(res.status).toBe(201);
    const s = await jsonOf(res);
    expect(s).toMatchObject({ readOnly: true, codeExpiresIn: 60, user: { id: t.userId, email: t.email, role: "admin" }, tenant: { id: t.tenantId, name: t.name } });
    expect(s.customerUrl).toBe(`https://app.example.test/impersonate#code=${s.code}`);
    expect(s.accessToken).toBeUndefined(); // the admin service never mints tenant tokens
    // stored hashed
    const [c] = await b.owner<{ code_hash: string; used_at: Date | null; expires_at: Date }[]>`SELECT code_hash, used_at, expires_at FROM impersonation_codes WHERE session_id = ${s.sessionId}`;
    expect(c!.code_hash).toBe(sha256(s.code));
    expect(JSON.stringify(await b.owner`SELECT * FROM impersonation_codes WHERE session_id = ${s.sessionId}`)).not.toContain(s.code);
    expect(c!.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    const [sess] = await b.owner<{ read_only: boolean }[]>`SELECT read_only FROM impersonation_sessions WHERE id = ${s.sessionId}`;
    expect(sess!.read_only).toBe(true);
    // owner may start write mode
    const w = await jsonOf(await call(b, "POST", url, owner, { reason: "customer asked us to fix their setup", readOnly: false }));
    expect(w.readOnly).toBe(false);
    // history + audit on both sides
    const hist = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/impersonations`, billing));
    expect(hist.total).toBe(2);
    expect(hist.items[0]).toMatchObject({ adminEmail: owner.email, readOnly: false, tenantName: t.name, reason: "customer asked us to fix their setup", endedAt: null, exchangedAt: null });
    const all = await jsonOf(await call(b, "GET", `/impersonations?tenantId=${t.tenantId}&adminId=${support.id}`, billing));
    expect(all.items.map((x: { id: string }) => x.id)).toEqual([s.sessionId]);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'impersonation.start'`).length).toBe(2);
    expect((await b.owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'impersonation.started'`).length).toBe(2);
    // end
    expect((await call(b, "POST", `/impersonation/${s.sessionId}/end`, billing)).status).toBe(403);
    expect((await call(b, "POST", `/impersonation/${s.sessionId}/end`, support)).status).toBe(200);
    expect((await call(b, "POST", `/impersonation/${s.sessionId}/end`, support)).status).toBe(404);
    // suspended tenants cannot be impersonated; unknown tenants 404
    await b.owner`UPDATE tenants SET status = 'suspended' WHERE id = ${t.tenantId}`;
    expect((await call(b, "POST", url, owner, { reason: "support ticket 43" })).status).toBe(409);
    expect((await call(b, "POST", `/tenants/${crypto.randomUUID()}/impersonate`, owner, { reason: "support ticket 43" })).status).toBe(404);
  });

  test("operations: dead jobs list, retry and discard (support+owner), failed webhooks; audited", async () => {
    const t = await mkTenant(b);
    const [j1] = await b.owner<{ id: string }[]>`INSERT INTO jobs (tenant_id, name, status, attempts, last_error, payload) VALUES (${t.tenantId}, 'channel.send', 'dead', 5, 'telegram 403', ${b.owner.json({ secret: "PAYLOADSECRET" })}) RETURNING id`;
    const [j2] = await b.owner<{ id: string }[]>`INSERT INTO jobs (tenant_id, name, status, attempts, last_error) VALUES (${t.tenantId}, 'knowledge.ingest', 'dead', 3, 'timeout') RETURNING id`;
    const list = await call(b, "GET", `/ops/dead-jobs?tenantId=${t.tenantId}`, billing);
    const lj = await jsonOf(list);
    expect(lj.total).toBe(2);
    expect(lj.items[0]).toMatchObject({ tenantId: t.tenantId, tenantName: t.name });
    expect(JSON.stringify(lj)).not.toContain("PAYLOADSECRET");
    expect((await call(b, "POST", `/ops/dead-jobs/${j1!.id}/retry`, billing)).status).toBe(403);
    expect((await call(b, "POST", `/ops/dead-jobs/${j1!.id}/retry`, support)).status).toBe(200);
    const [r] = await b.owner<{ status: string; attempts: number }[]>`SELECT status, attempts FROM jobs WHERE id = ${j1!.id}`;
    expect(r).toEqual({ status: "queued", attempts: 0 });
    expect((await call(b, "POST", `/ops/dead-jobs/${j1!.id}/retry`, support)).status).toBe(404); // no longer dead
    expect((await call(b, "POST", `/ops/dead-jobs/${j2!.id}/discard`, owner)).status).toBe(200);
    expect((await b.owner`SELECT 1 FROM jobs WHERE id = ${j2!.id}`).length).toBe(0);
    expect((await call(b, "POST", `/ops/dead-jobs/${j2!.id}/discard`, owner)).status).toBe(404);
    expect((await jsonOf(await call(b, "GET", `/ops/dead-jobs?tenantId=${t.tenantId}&offset=5`, support))).total).toBe(0);
    const acts = (await b.owner<{ action: string }[]>`SELECT action FROM platform_audit_logs WHERE tenant_id = ${t.tenantId}`).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["job.retry", "job.discard"]));
    // failed webhooks
    const [w] = await b.owner<{ id: string }[]>`INSERT INTO webhooks (tenant_id, name, url, secret_encrypted, events) VALUES (${t.tenantId}, 'hook', 'https://h.example.test/x?s=1', 'v1.zzz', ${["message.created"]}) RETURNING id`;
    await b.owner`INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, status, attempts, response_status, last_error) VALUES (${t.tenantId}, ${w!.id}, ${crypto.randomUUID()}, 'message.created', '{"x":1}'::jsonb, 'failed', 5, 502, 'bad gateway')`;
    const fw = await jsonOf(await call(b, "GET", `/ops/failed-webhooks?tenantId=${t.tenantId}`, billing));
    expect(fw.items).toEqual([expect.objectContaining({ tenantId: t.tenantId, webhookName: "hook", eventType: "message.created", responseStatus: 502, lastError: "bad gateway", attempts: 5 })]);
    expect(JSON.stringify(fw)).not.toContain("h.example.test");
  });

  test("lifecycle and plan: owner suspends/deletes/restores; billing changes plan; support cannot; audited on both sides", async () => {
    const t = await mkTenant(b, "life", "free");
    for (const [m, p] of [["POST", "suspend"], ["POST", "unsuspend"], ["POST", "restore"], ["DELETE", ""]] as const) {
      const path = `/tenants/${t.tenantId}${p ? `/${p}` : ""}`;
      expect([m, p, (await call(b, m, path, support)).status]).toEqual([m, p, 403]);
      expect([m, p, (await call(b, m, path, billing)).status]).toEqual([m, p, 403]);
    }
    expect((await call(b, "PATCH", `/tenants/${t.tenantId}`, billing, { name: "x" })).status).toBe(403);
    expect((await call(b, "PUT", `/tenants/${t.tenantId}/plan`, support, { plan: "pro" })).status).toBe(403);
    expect(await jsonOf(await call(b, "PUT", `/tenants/${t.tenantId}/plan`, billing, { plan: "pro" }))).toEqual({ id: t.tenantId, plan: "pro" });
    expect((await call(b, "PUT", `/tenants/${t.tenantId}/plan`, billing, { plan: "nope" })).status).toBe(400);
    expect((await call(b, "PUT", `/tenants/${crypto.randomUUID()}/plan`, billing, { plan: "pro" })).status).toBe(404);
    expect((await call(b, "PUT", `/tenants/${t.tenantId}/plan`, billing, { plan: "pro", x: 1 })).status).toBe(400);
    const [p] = await b.owner<{ plan_key: string }[]>`SELECT plan_key FROM tenants WHERE id = ${t.tenantId}`;
    expect(p!.plan_key).toBe("pro");
    expect(await jsonOf(await call(b, "PATCH", `/tenants/${t.tenantId}`, owner, { name: "Renamed Co" }))).toMatchObject({ name: "Renamed Co", plan: "pro", status: "active" });
    expect((await call(b, "PATCH", `/tenants/${t.tenantId}`, owner, { name: "x", plan: "free" })).status).toBe(400); // plan only via /plan
    expect(await jsonOf(await call(b, "POST", `/tenants/${t.tenantId}/suspend`, owner))).toMatchObject({ status: "suspended" });
    expect(await jsonOf(await call(b, "POST", `/tenants/${t.tenantId}/unsuspend`, owner))).toMatchObject({ status: "active" });
    expect(await jsonOf(await call(b, "DELETE", `/tenants/${t.tenantId}`, owner))).toMatchObject({ status: "deleted" });
    expect((await jsonOf(await call(b, "GET", `/tenants?status=deleted&q=Renamed`, owner))).items.map((x: { id: string }) => x.id)).toContain(t.tenantId);
    expect((await call(b, "POST", `/tenants/${t.tenantId}/restore`, owner)).status).toBe(200);
    await b.owner`UPDATE tenants SET status = 'deleted', deleted_at = now() - interval '31 days' WHERE id = ${t.tenantId}`;
    expect((await call(b, "POST", `/tenants/${t.tenantId}/restore`, owner)).status).toBe(409);
    expect((await call(b, "POST", `/tenants/${crypto.randomUUID()}/suspend`, owner)).status).toBe(404);
    expect((await b.owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'tenant.status.suspended'`).length).toBe(1);
    const acts = (await b.owner<{ action: string }[]>`SELECT action FROM platform_audit_logs WHERE tenant_id = ${t.tenantId}`).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["tenant.update", "tenant.status.suspended", "tenant.status.active", "tenant.status.deleted"]));
  });

  test("create customer: owner only, validation, duplicate email", async () => {
    const oe = `${uniq("o")}@customer.example.test`;
    const body = { name: "Created Co", plan: "pro", ownerEmail: oe, ownerName: "O", ownerPassword: "correct horse battery staple" };
    expect((await call(b, "POST", "/tenants", support, body)).status).toBe(403);
    const r = await call(b, "POST", "/tenants", owner, body);
    expect(r.status).toBe(201);
    const { id } = await jsonOf(r);
    const [row] = await b.owner<{ plan_key: string; hash: string }[]>`SELECT t.plan_key, u.password_hash AS hash FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE t.id = ${id}`;
    expect(row!.plan_key).toBe("pro");
    expect(row!.hash.startsWith("$argon2id$")).toBe(true);
    expect((await call(b, "POST", "/tenants", owner, { ...body, plan: "nope", ownerEmail: `${uniq("p")}@customer.example.test` })).status).toBe(400);
    expect((await call(b, "POST", "/tenants", owner, body)).status).toBe(409);
    expect((await call(b, "POST", "/tenants", owner, { ...body, ownerPassword: "short" })).status).toBe(400);
    expect((await call(b, "POST", "/tenants", owner, { ...body, extra: 1 })).status).toBe(400);
  });

  test("flags and credits: owner overrides flags, billing grants credits, support cannot; reason required", async () => {
    const t = await mkTenant(b);
    const key = `flag.${uniq("f")}`;
    expect((await call(b, "PUT", `/feature-flags/${key}`, billing, { defaultEnabled: true })).status).toBe(403);
    expect((await call(b, "PUT", `/feature-flags/${key}`, owner, { description: "d", defaultEnabled: false })).status).toBe(200);
    expect((await call(b, "PUT", `/tenants/${t.tenantId}/flags/${key}`, support, { enabled: true })).status).toBe(403);
    expect((await call(b, "PUT", `/tenants/${t.tenantId}/flags/${key}`, owner, { enabled: true })).status).toBe(200);
    let f = (await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/flags`, support))).items.find((x: { key: string }) => x.key === key);
    expect(f).toEqual({ key, defaultEnabled: false, override: true, effective: true });
    await call(b, "PUT", `/tenants/${t.tenantId}/flags/${key}`, owner, { enabled: null });
    f = (await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/flags`, support))).items.find((x: { key: string }) => x.key === key);
    expect(f).toMatchObject({ override: null, effective: false });
    expect((await call(b, "PUT", `/tenants/${t.tenantId}/flags/nonexistent.flag`, owner, { enabled: true })).status).toBe(404);
    expect((await call(b, "DELETE", `/feature-flags/${key}`, owner)).status).toBe(200);
    expect((await call(b, "DELETE", `/feature-flags/${key}`, owner)).status).toBe(404);

    const cr = `/tenants/${t.tenantId}/credits`;
    expect((await call(b, "POST", cr, support, { credits: 5, reason: "goodwill" })).status).toBe(403);
    expect((await call(b, "POST", cr, billing, { credits: 5, reason: "x" })).status).toBe(400);
    expect((await call(b, "POST", cr, billing, { credits: 0, reason: "nothing to do" })).status).toBe(400);
    expect((await call(b, "POST", cr, billing, { credits: 1e9, reason: "way too much" })).status).toBe(400);
    expect((await call(b, "POST", cr, billing, { credits: 5, reason: "ok reason", tenantId: t.tenantId })).status).toBe(400);
    expect((await call(b, "POST", `/tenants/${crypto.randomUUID()}/credits`, billing, { credits: 5, reason: "unknown tenant" })).status).toBe(404);
    const g = await jsonOf(await call(b, "POST", cr, billing, { credits: 100.5, reason: "Goodwill after outage" }));
    expect(g).toMatchObject({ topupMicro: 100_500_000, planKey: "pro" });
    expect(await jsonOf(await call(b, "POST", cr, owner, { credits: -50.5, reason: "Correction" }))).toMatchObject({ topupMicro: 50_000_000 });
    expect(await jsonOf(await call(b, "GET", cr, support))).toMatchObject({ topupMicro: 50_000_000 });
    const [aud] = await b.owner<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM platform_audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'credits.grant' ORDER BY created_at LIMIT 1`;
    expect(aud!.metadata).toMatchObject({ creditsMicro: 100_500_000, reason: "Goodwill after outage" });
  });
});
