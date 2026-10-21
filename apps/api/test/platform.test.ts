import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { MockEmailProvider, createMockProviders } from "@yulona/providers";
import { createApp } from "../src/app";
import { checkLimit, incrementUsage } from "../src/platform/limits";
import { MemoryRateLimiter } from "../src/ratelimit";
import { hashPassword } from "../src/security";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("platform", () => {
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let app: ReturnType<typeof createApp>;
  let limiter: MemoryRateLimiter;
  const email = new MockEmailProvider();

  beforeAll(async () => {
    const t = await setupTestDb();
    owner = t.owner; db = t.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({}, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; c.rateLimits.register = { limit: 1e6, windowMs: 60_000 }; c.rateLimits.loginIp = { limit: 1e6, windowMs: 60_000 }; c.rateLimits.loginIpEmail = { limit: 1e6, windowMs: 60_000 }; });
    app = createApp({ cfg, db, limiter, log: createLogger({ level: "silent" }), providers: { ...createMockProviders(), email } });
  });
  afterAll(async () => { limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  const fails = async (q: PromiseLike<unknown>) => { try { await q; return false; } catch { return true; } };
  const call = (path: string, token: string | null, init: RequestInit = {}) =>
    app.request(`/api/v1${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as object) } });
  const send = (method: string, path: string, token: string | null, body?: unknown) =>
    call(path, token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  async function newTenant(plan = "enterprise") {
    const e = uniqueEmail("own");
    const res = await app.request("/api/v1/auth/register", json({ email: e, password: PASSWORD, name: "Owner", workspaceName: "WS" }));
    const s = (await res.json()) as { accessToken: string; tenant: { id: string }; user: { id: string } };
    await owner`UPDATE tenants SET plan_key = ${plan} WHERE id = ${s.tenant.id}`;
    return { token: s.accessToken, tenantId: s.tenant.id, userId: s.user.id, email: e };
  }
  async function login(e: string, password = PASSWORD) {
    const r = await app.request("/api/v1/auth/login", json({ email: e, password }));
    return r.status === 200 ? ((await r.json()) as { accessToken: string }).accessToken : null;
  }
  /** Invite + accept + login; returns the new member's token + id. */
  async function addMember(t: { token: string }, role: string) {
    const e = uniqueEmail(role);
    const inv = await send("POST", "/invitations", t.token, { email: e, role });
    expect(inv.status).toBe(201);
    const { inviteUrl } = (await inv.json()) as { inviteUrl: string };
    const token = new URL(inviteUrl).searchParams.get("token")!;
    const acc = await app.request("/api/v1/invitations/accept", json({ token, name: "Member", password: PASSWORD }));
    expect(acc.status).toBe(201);
    const jwt = (await login(e))!;
    const me = (await (await call("/me", jwt)).json()) as { user: { id: string } };
    return { token: jwt, id: me.user.id, email: e, inviteToken: token };
  }

  test("every platform endpoint requires auth", async () => {
    for (const [m, p] of [["GET", "/users"], ["PATCH", `/users/${crypto.randomUUID()}`], ["GET", "/invitations"], ["POST", "/invitations"], ["GET", "/agents"], ["POST", "/agents"],
      ["GET", "/api-keys"], ["POST", "/api-keys"], ["GET", "/audit-logs"], ["GET", "/tenant"], ["PATCH", "/tenant"], ["GET", "/feature-flags"], ["GET", "/key-info"]] as const) {
      const r = await send(m, p, null, m === "GET" ? undefined : {});
      expect([m, p, r.status]).toEqual([m, p, 401]);
    }
  });

  test("invitations, roles, member management", async () => {
    const a = await newTenant();
    const agent = await addMember(a, "agent");
    const viewer = await addMember(a, "viewer");
    const admin = await addMember(a, "admin");
    expect(email.sent.some((m) => m.to === agent.email && /accept-invite\?token=/.test(m.text))).toBe(true);

    // token is single-use; garbage token rejected
    const reuse = await app.request("/api/v1/invitations/accept", json({ token: agent.inviteToken, name: "X", password: PASSWORD }));
    expect(reuse.status).toBe(400);
    expect((await app.request("/api/v1/invitations/accept", json({ token: "x".repeat(43), name: "X", password: PASSWORD }))).status).toBe(400);
    expect((await app.request("/api/v1/invitations/accept", json({ token: "x".repeat(43), name: "X", password: PASSWORD, tenantId: a.tenantId }))).status).toBe(400); // strict

    // role gates
    expect((await send("POST", "/invitations", agent.token, { email: uniqueEmail(), role: "viewer" })).status).toBe(403);
    expect((await send("GET", "/users", viewer.token)).status).toBe(200);
    expect((await send("PATCH", `/users/${agent.id}`, viewer.token, { name: "n" })).status).toBe(403);
    expect((await send("POST", "/invitations", admin.token, { email: uniqueEmail(), role: "owner" })).status).toBe(403);
    // admin can demote agent -> viewer but not touch owner, and cannot self-escalate
    expect((await send("PATCH", `/users/${agent.id}`, admin.token, { role: "viewer" })).status).toBe(200);
    expect((await send("PATCH", `/users/${a.userId}`, admin.token, { role: "agent" })).status).toBe(403);
    expect((await send("PATCH", `/users/${admin.id}`, admin.token, { role: "owner" })).status).toBe(403);
    // last owner protection + self-change
    expect((await send("PATCH", `/users/${a.userId}`, a.token, { role: "admin" })).status).toBe(403);
    const o2 = await addMember(a, "owner");
    expect((await send("PATCH", `/users/${a.userId}`, o2.token, { status: "disabled" })).status).toBe(200);
    expect((await send("PATCH", `/users/${o2.id}`, o2.token, { status: "disabled" })).status).toBe(403);
    expect(await login(a.email)).toBeNull(); // disabled
    expect((await send("PATCH", `/users/${a.userId}`, o2.token, { status: "active" })).status).toBe(200);
    expect((await send("PATCH", `/users/${a.userId}`, o2.token, { unknown: 1 })).status).toBe(400);

    // revoke invitation
    const inv = (await (await send("POST", "/invitations", o2.token, { email: uniqueEmail(), role: "agent" })).json()) as { id: string; inviteUrl: string };
    expect((await send("DELETE", `/invitations/${inv.id}`, o2.token)).status).toBe(200);
    const tok = new URL(inv.inviteUrl).searchParams.get("token")!;
    expect((await app.request("/api/v1/invitations/accept", json({ token: tok, name: "X", password: PASSWORD }))).status).toBe(400);
    // audit trail exists
    const logs = (await (await call("/audit-logs?action=invitation.created", o2.token)).json()) as { items: { action: string }[] };
    expect(logs.items.length).toBeGreaterThan(0);
  });

  test("cross-tenant isolation on platform resources", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const bm = await addMember(b, "agent");
    const agent = (await (await send("POST", "/agents", a.token, { name: "A-bot" })).json()) as { id: string };
    const key = (await (await send("POST", "/api-keys", a.token, { name: "k" })).json()) as { id: string };
    const inv = (await (await send("POST", "/invitations", a.token, { email: uniqueEmail(), role: "agent" })).json()) as { id: string };
    expect((await send("GET", `/agents/${agent.id}`, b.token)).status).toBe(404);
    expect((await send("PATCH", `/agents/${agent.id}`, b.token, { name: "x" })).status).toBe(404);
    expect((await send("POST", `/agents/${agent.id}/publish`, b.token, {})).status).toBe(404);
    expect((await send("GET", `/agents/${agent.id}/versions`, b.token)).status).toBe(404);
    expect((await send("DELETE", `/agents/${agent.id}`, b.token)).status).toBe(404);
    expect((await send("DELETE", `/api-keys/${key.id}`, b.token)).status).toBe(404);
    expect((await send("DELETE", `/invitations/${inv.id}`, b.token)).status).toBe(404);
    expect((await send("PATCH", `/users/${a.userId}`, b.token, { name: "x" })).status).toBe(404);
    const bAgents = (await (await send("GET", "/agents", b.token)).json()) as { items: unknown[] };
    expect(bAgents.items).toEqual([]);
    const bUsers = (await (await send("GET", "/users", bm.token)).json()) as { items: { id: string }[] };
    expect(bUsers.items.map((u) => u.id)).not.toContain(a.userId);
    const bAudit = (await (await send("GET", "/audit-logs?limit=200", b.token)).json()) as { items: { resourceId: string }[] };
    expect(bAudit.items.some((x) => x.resourceId === agent.id)).toBe(false);
    // body-supplied tenantId is rejected, never honoured
    expect((await send("POST", "/agents", b.token, { name: "x", tenantId: a.tenantId })).status).toBe(400);
  });

  test("agents: create, validate, publish, versions, rollback, archive, plan limit", async () => {
    const a = await newTenant();
    const viewer = await addMember(a, "viewer");
    expect((await send("POST", "/agents", viewer.token, { name: "x" })).status).toBe(403);
    expect((await send("POST", "/agents", a.token, { name: "x", config: { similarityThreshold: 2 } })).status).toBe(400);
    const created = (await (await send("POST", "/agents", a.token, { name: "Bot", config: { systemPrompt: "v1", topK: 3 } })).json()) as { id: string; status: string; config: Record<string, unknown>; publishedVersion: number | null };
    expect(created.status).toBe("draft");
    expect(created.config.similarityThreshold).toBe(0.15);
    expect(created.config.enabledTools).toEqual(["qualify_lead", "collect_contact", "escalate_to_human"]);
    expect(created.publishedVersion).toBeNull();
    const id = created.id;
    const p1 = (await (await send("POST", `/agents/${id}/publish`, a.token, { note: "first" })).json()) as { version: number; status: string };
    expect([p1.version, p1.status]).toEqual([1, "published"]);
    await send("PATCH", `/agents/${id}`, a.token, { config: { systemPrompt: "v2" } });
    const p2 = (await (await send("POST", `/agents/${id}/publish`, a.token, {})).json()) as { version: number };
    expect(p2.version).toBe(2);
    const rb = (await (await send("POST", `/agents/${id}/rollback`, a.token, { version: 1 })).json()) as { version: number; config: { systemPrompt: string }; publishedVersion: number };
    expect([rb.version, rb.config.systemPrompt, rb.publishedVersion]).toEqual([3, "v1", 3]);
    expect((await send("POST", `/agents/${id}/rollback`, a.token, { version: 99 })).status).toBe(404);
    const vs = (await (await send("GET", `/agents/${id}/versions`, viewer.token)).json()) as { items: { version: number }[] };
    expect(vs.items.map((v) => v.version)).toEqual([3, 2, 1]);
    // published config is immutable history: version 1 still has systemPrompt v1
    const [v1] = await owner`SELECT config FROM agent_versions WHERE agent_id = ${id} AND version = 1`;
    expect(v1!.config.systemPrompt).toBe("v1");
    expect((await send("DELETE", `/agents/${id}`, a.token)).status).toBe(200);
    expect((await send("PATCH", `/agents/${id}`, a.token, { name: "z" })).status).toBe(409);
    expect((await send("POST", `/agents/${id}/unarchive`, a.token)).status).toBe(200);
    expect(((await (await send("GET", `/agents/${id}`, a.token)).json()) as { status: string }).status).toBe("published");

    // free plan: 1 agent max
    const f = await newTenant("free");
    expect((await send("POST", "/agents", f.token, { name: "one" })).status).toBe(201);
    const over = await send("POST", "/agents", f.token, { name: "two" });
    expect(over.status).toBe(402);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("plan_limit_exceeded");
  });

  test("api keys: shown once, hash only, scopes, per-key rate limit, revoke", async () => {
    const a = await newTenant();
    const agent = await addMember(a, "agent");
    expect((await send("GET", "/api-keys", agent.token)).status).toBe(403);
    expect((await send("POST", "/api-keys", a.token, { name: "k", scopes: ["bogus"] })).status).toBe(400);
    const res = await send("POST", "/api-keys", a.token, { name: "ci", scopes: ["contacts:read"], rateLimitPerMinute: 2 });
    expect(res.status).toBe(201);
    const k = (await res.json()) as { id: string; key: string; prefix: string };
    expect(k.key.startsWith(k.prefix)).toBe(true);
    const stored = await owner`SELECT key_hash, prefix FROM api_keys WHERE id = ${k.id}`;
    expect(stored[0]!.key_hash).not.toContain(k.key);
    expect(JSON.stringify(stored)).not.toContain(k.key.slice(-20));
    const list = (await (await send("GET", "/api-keys", a.token)).json()) as { items: Record<string, unknown>[] };
    expect(JSON.stringify(list)).not.toContain(k.key.slice(-20));
    const info = await call("/key-info", k.key);
    expect(info.status).toBe(200);
    expect(((await info.json()) as { tenantId: string }).tenantId).toBe(a.tenantId);
    expect((await call("/key-info", k.key + "x")).status).toBe(401);
    expect((await call("/me", k.key)).status).toBe(401); // API keys are not dashboard tokens
    expect((await call("/key-info", k.key)).status).toBe(200);
    expect((await call("/key-info", k.key)).status).toBe(429); // 2/min
    expect((await send("DELETE", `/api-keys/${k.id}`, a.token)).status).toBe(200);
    expect((await call("/key-info", k.key)).status).toBe(401);
  });

  test("audit log API: filters, keyset pagination, role gate", async () => {
    const a = await newTenant();
    const viewer = await addMember(a, "viewer");
    for (let i = 0; i < 5; i++) await send("POST", "/agents", a.token, { name: `n${i}` });
    expect((await send("GET", "/audit-logs", viewer.token)).status).toBe(403);
    const p1 = (await (await send("GET", "/audit-logs?action=agent.created&limit=2", a.token)).json()) as { items: { id: string; action: string }[]; nextCursor: string | null };
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await (await send("GET", `/audit-logs?action=agent.created&limit=10&cursor=${encodeURIComponent(p1.nextCursor!)}`, a.token)).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(p2.items.length).toBe(3);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(5);
    expect((await send("GET", "/audit-logs?cursor=garbage", a.token)).status).toBe(400);
    expect((await send("GET", "/audit-logs?limit=9999", a.token)).status).toBe(400);
  });

  test("tenant self-service + limits + usage helpers", async () => {
    const a = await newTenant("pro");
    const t = (await (await send("GET", "/tenant", a.token)).json()) as { plan: { key: string }; limits: { metric: string; limit: number; used: number }[] };
    expect(t.plan.key).toBe("pro");
    expect(t.limits.find((l) => l.metric === "seats")).toMatchObject({ limit: 10, used: 1 });
    const viewer = await addMember(a, "viewer");
    expect((await send("PATCH", "/tenant", viewer.token, { name: "x" })).status).toBe(403);
    expect((await send("PATCH", "/tenant", a.token, { name: "Renamed" })).status).toBe(200);
    // a tenant cannot change its own plan via any path
    expect((await send("PATCH", "/tenant", a.token, { name: "x", plan: "enterprise" })).status).toBe(400);
    expect(await fails(db`UPDATE tenants SET plan_key = 'enterprise'`)).toBe(true);
    // checkLimit / incrementUsage
    expect((await checkLimit(db, a.tenantId, "monthly_conversations")).used).toBe(0);
    await incrementUsage(db, a.tenantId, "monthly_conversations", 100);
    const c = await checkLimit(db, a.tenantId, "monthly_conversations", 1);
    expect([c.limit, c.used, c.allowed, c.warning]).toEqual([2000, 100, true, false]);
    await incrementUsage(db, a.tenantId, "monthly_conversations", 1900);
    expect((await checkLimit(db, a.tenantId, "monthly_conversations")).allowed).toBe(false);
    const ent = await newTenant("enterprise");
    expect((await checkLimit(db, ent.tenantId, "seats")).limit).toBeNull();
  });

  describe("super admin", () => {
    let sa: string;
    const adminEmail = uniqueEmail("sa");
    beforeAll(async () => {
      await owner`INSERT INTO platform_admins (email, name, password_hash) VALUES (${adminEmail}, 'Root', ${await hashPassword(PASSWORD)})`;
      const r = await app.request("/api/v1/admin/auth/login", json({ email: adminEmail, password: PASSWORD }));
      expect(r.status).toBe(200);
      sa = ((await r.json()) as { accessToken: string }).accessToken;
    });

    test("separate token realm; bad credentials generic", async () => {
      expect((await app.request("/api/v1/admin/auth/login", json({ email: adminEmail, password: "wrong-password-xx" }))).status).toBe(401);
      expect((await call("/admin/tenants", null)).status).toBe(401);
      const t = await newTenant();
      expect((await call("/admin/tenants", t.token)).status).toBe(401); // tenant token is not an admin token
      expect((await call("/me", sa)).status).toBe(401); // admin token does not open tenant APIs
      expect((await call("/agents", sa)).status).toBe(401);
      expect((await call("/admin/auth/me", sa)).status).toBe(200);
      // a tenant user (even owner) is not a platform admin
      expect((await app.request("/api/v1/admin/auth/login", json({ email: t.email, password: PASSWORD }))).status).toBe(401);
      // app role cannot read platform_admins directly
      expect(await fails(db`SELECT * FROM platform_admins`)).toBe(true);
    });

    test("tenant lifecycle: create, list, suspend, unsuspend, delete, restore, purge", async () => {
      const oe = uniqueEmail("created");
      const cr = await send("POST", "/admin/tenants", sa, { name: "Created Co", plan: "pro", ownerEmail: oe, ownerName: "O", ownerPassword: PASSWORD });
      expect(cr.status).toBe(201);
      const { id } = (await cr.json()) as { id: string };
      expect((await send("POST", "/admin/tenants", sa, { name: "x", plan: "nope", ownerEmail: uniqueEmail(), ownerName: "O", ownerPassword: PASSWORD })).status).toBe(400);
      expect((await send("POST", "/admin/tenants", sa, { name: "x", ownerEmail: oe, ownerName: "O", ownerPassword: PASSWORD })).status).toBe(409);
      const list = (await (await call("/admin/tenants?q=Created%20Co", sa)).json()) as { items: { id: string; plan: string; userCount: number }[]; total: number };
      expect(list.items.find((t) => t.id === id)).toMatchObject({ plan: "pro", userCount: 1 });

      const tok = (await login(oe))!;
      expect(tok).toBeTruthy();
      expect((await send("POST", `/admin/tenants/${id}/suspend`, sa)).status).toBe(200);
      expect(await login(oe)).toBeNull();
      expect((await send("POST", `/admin/tenants/${id}/unsuspend`, sa)).status).toBe(200);
      expect(await login(oe)).toBeTruthy();
      expect((await send("PATCH", `/admin/tenants/${id}`, sa, { name: "Renamed Co", plan: "free" })).status).toBe(200);
      expect((await send("DELETE", `/admin/tenants/${id}`, sa)).status).toBe(200);
      expect(await login(oe)).toBeNull();
      expect((await send("POST", `/admin/tenants/${id}/restore`, sa)).status).toBe(200);
      expect(await login(oe)).toBeTruthy();
      // audit rows on both sides
      expect((await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${id} AND action = 'tenant.status.suspended'`).length).toBe(1);
      const pa = (await (await call("/admin/audit-logs", sa)).json()) as { items: { action: string }[] };
      expect(pa.items.some((x) => x.action === "tenant.status.deleted")).toBe(true);

      // soft delete + 30 days => hard delete (including dependent rows)
      await send("DELETE", `/admin/tenants/${id}`, sa);
      const { purgeDeletedTenants } = await import("../../worker/src/maintenance");
      expect(await purgeDeletedTenants(db)).toBeGreaterThanOrEqual(0);
      expect((await owner`SELECT 1 FROM tenants WHERE id = ${id}`).length).toBe(1); // not old enough
      await owner`UPDATE tenants SET deleted_at = now() - interval '31 days' WHERE id = ${id}`;
      expect((await send("POST", `/admin/tenants/${id}/restore`, sa)).status).toBe(409); // grace passed
      expect(await purgeDeletedTenants(db)).toBeGreaterThanOrEqual(1);
      expect((await owner`SELECT 1 FROM tenants WHERE id = ${id}`).length).toBe(0);
      expect((await owner`SELECT 1 FROM users WHERE tenant_id = ${id}`).length).toBe(0);
      expect((await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${id}`).length).toBe(0);
    });

    test("feature flags + plan limits", async () => {
      const key = `flag.${crypto.randomUUID().slice(0, 8)}`;
      const t = await newTenant();
      expect((await send("PUT", `/admin/feature-flags/${key}`, t.token, { defaultEnabled: true })).status).toBe(401);
      expect((await send("PUT", `/admin/feature-flags/${key}`, sa, { description: "d", defaultEnabled: false })).status).toBe(200);
      const eff = async () => ((await (await call("/feature-flags", t.token)).json()) as { flags: Record<string, boolean> }).flags[key];
      expect(await eff()).toBe(false);
      expect((await send("PUT", `/admin/tenants/${t.tenantId}/flags/${key}`, sa, { enabled: true })).status).toBe(200);
      expect(await eff()).toBe(true);
      const other = await newTenant();
      expect(((await (await call("/feature-flags", other.token)).json()) as { flags: Record<string, boolean> }).flags[key]).toBe(false);
      expect((await send("PUT", `/admin/tenants/${t.tenantId}/flags/${key}`, sa, { enabled: null })).status).toBe(200);
      expect(await eff()).toBe(false);
      expect((await send("PUT", `/admin/tenants/${t.tenantId}/flags/nonexistent.flag`, sa, { enabled: true })).status).toBe(404);
      expect(await fails(db`INSERT INTO feature_flags (key) VALUES ('hack.flag')`)).toBe(true); // tenants can't write flags
      expect((await send("DELETE", `/admin/feature-flags/${key}`, sa)).status).toBe(200);

      expect((await send("PUT", "/admin/plans/free/limits/seats", sa, { limit: 3 })).status).toBe(200);
      const plans = (await (await call("/admin/plans", sa)).json()) as { items: { key: string; limits: Record<string, number | null> }[] };
      expect(plans.items.find((p) => p.key === "free")!.limits.seats).toBe(3);
      await send("PUT", "/admin/plans/free/limits/seats", sa, { limit: 2 });
    });
  });
});
