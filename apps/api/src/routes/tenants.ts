// Tenant self-service (owner/admin) + super-admin (platform) APIs: auth, tenants, plans, flags, audit.
import { Hono, type MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import { z } from "zod";
import { withTenant, type Db } from "@yulona/db";
import { emailSchema, passwordSchema } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { enforceLimit, requireAuth } from "../middleware";
import { LIMIT_METRICS, checkLimit } from "../platform/limits";
import { requireMinRole } from "../platform/authz";
import { audit, isFkViolation, isUniqueViolation, parseId, parseQuery } from "../platform/util";
import type { RateLimiter } from "../ratelimit";
import { hashPassword, verifyPassword } from "../security";
import { flagKeySchema } from "./flags";

// ------------------------------------------------------------------ tenant self-service
export function tenantRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.use("/tenant/*", requireAuth(cfg));

  r.get("/tenant", async (c) => {
    const { tenantId } = c.get("auth");
    const out = await withTenant(db, tenantId, async (tx) => {
      const [t] = await tx<{ id: string; name: string; status: string; planKey: string; planName: string }[]>`
        SELECT t.id, t.name, t.status, t.plan_key, p.name AS plan_name FROM tenants t JOIN plans p ON p.key = t.plan_key WHERE t.id = ${tenantId}`;
      const limits = await Promise.all(LIMIT_METRICS.map((m) => checkLimit(tx, tenantId, m)));
      return { t, limits };
    });
    if (!out.t) throw Errors.notFound();
    return c.json({
      id: out.t.id, name: out.t.name, status: out.t.status, plan: { key: out.t.planKey, name: out.t.planName },
      limits: out.limits.map((l) => ({ metric: l.metric, limit: l.limit, used: l.used, warning: l.warning })),
    });
  });

  r.patch("/tenant", requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const body = await parseBody(c, z.strictObject({ name: z.string().trim().min(1).max(100) }));
    await withTenant(db, tenantId, async (tx) => {
      await tx`UPDATE tenants SET name = ${body.name}, updated_at = now() WHERE id = ${tenantId}`;
      await audit(tx, c, "tenant.renamed", "tenant", tenantId, { name: body.name });
    });
    return c.json({ id: tenantId, name: body.name });
  });
  return r;
}

// ------------------------------------------------------------------ super admin
type AdminEnv = { Variables: AppEnv["Variables"] & { adminId: string } };
const adminSecret = (cfg: Config) => `${cfg.jwtSecret}:platform-admin`; // distinct key => tenant tokens never validate here and vice versa
const ADMIN_TTL_S = 900;

const requirePlatformAdmin = (cfg: Config, db: Db): MiddlewareHandler<AdminEnv> => async (c, next) => {
  const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(c.req.header("authorization") ?? "");
  if (!m) throw Errors.unauthorized();
  let sub: string;
  try {
    const p = await verify(m[1]!, adminSecret(cfg), "HS256");
    if (p.typ !== "sa" || typeof p.sub !== "string") throw new Error("bad");
    sub = p.sub;
  } catch {
    throw Errors.unauthorized("Invalid or expired token");
  }
  const [a] = await db<{ adminId: string; status: string }[]>`SELECT * FROM sa_get_admin(${sub})`;
  if (!a || a.status !== "active") throw Errors.unauthorized();
  c.set("adminId", a.adminId);
  await next();
};

const planKey = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const createTenantSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  plan: planKey.default("free"),
  ownerEmail: emailSchema,
  ownerName: z.string().trim().min(1).max(100),
  ownerPassword: passwordSchema,
});
const patchTenantSchema = z.strictObject({ name: z.string().trim().min(1).max(100).optional(), plan: planKey.optional() })
  .refine((v) => Object.keys(v).length > 0, "At least one field required");

interface TenantRow { id: string; name: string; status: string; planKey: string; deletedAt: Date | null; createdAt: Date; userCount: string }
const tdto = (t: TenantRow) => ({
  id: t.id, name: t.name, status: t.status, plan: t.planKey, deletedAt: t.deletedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(), userCount: Number(t.userCount),
});

export function adminRoutes({ cfg, db, limiter }: { cfg: Config; db: Db; limiter: RateLimiter }) {
  const r = new Hono<AdminEnv>();

  r.post("/auth/login", async (c) => {
    const ip = c.get("ip");
    await enforceLimit(limiter, `sa:login:ip:${ip}`, cfg.rateLimits.loginIp);
    const body = await parseBody(c, z.strictObject({ email: emailSchema, password: z.string().min(1).max(128) }));
    await enforceLimit(limiter, `sa:login:${ip}:${body.email}`, cfg.rateLimits.loginIpEmail);
    const [a] = await db<{ adminId: string; email: string; name: string; passwordHash: string; status: string; lockedUntil: Date | null }[]>`
      SELECT * FROM sa_find_admin(${body.email})`;
    const ok = await verifyPassword(body.password, a?.passwordHash);
    const locked = !!a?.lockedUntil && a.lockedUntil.getTime() > Date.now();
    if (!a || a.status !== "active" || locked || !ok) {
      if (a && a.status === "active" && !locked) await db`SELECT sa_record_login(${a.adminId}, false)`;
      throw Errors.invalidCredentials();
    }
    await db`SELECT sa_record_login(${a.adminId}, true)`;
    const iat = Math.floor(Date.now() / 1000);
    const accessToken = await sign({ sub: a.adminId, typ: "sa", role: "super_admin", iat, exp: iat + ADMIN_TTL_S, jti: crypto.randomUUID() }, adminSecret(cfg), "HS256");
    return c.json({ accessToken, expiresIn: ADMIN_TTL_S, admin: { id: a.adminId, email: a.email, name: a.name } });
  });

  r.use("*", requirePlatformAdmin(cfg, db));

  r.get("/auth/me", async (c) => {
    const [a] = await db<{ adminId: string; email: string; name: string }[]>`SELECT * FROM sa_get_admin(${c.get("adminId")})`;
    return c.json({ id: a!.adminId, email: a!.email, name: a!.name });
  });

  // ---- tenants
  r.get("/tenants", async (c) => {
    const q = parseQuery(c, z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }));
    const rows = await db<(TenantRow & { total: string })[]>`SELECT * FROM sa_list_tenants(${q.q ?? null}, ${q.limit}, ${q.offset})`;
    return c.json({ items: rows.map(tdto), total: rows[0] ? Number(rows[0].total) : 0 });
  });
  r.get("/tenants/:id", async (c) => {
    const [t] = await db<TenantRow[]>`SELECT * FROM sa_get_tenant(${parseId(c)})`;
    if (!t) throw Errors.notFound("Tenant not found");
    return c.json(tdto(t));
  });
  r.post("/tenants", async (c) => {
    const body = await parseBody(c, createTenantSchema);
    const hash = await hashPassword(body.ownerPassword);
    try {
      const [row] = await db<{ rTenantId: string; rUserId: string }[]>`
        SELECT * FROM sa_create_tenant(${c.get("adminId")}, ${body.name}, ${body.plan}, ${body.ownerEmail}, ${body.ownerName}, ${hash})`;
      return c.json({ id: row!.rTenantId, ownerUserId: row!.rUserId }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("Owner email is already registered");
      if (isFkViolation(e)) throw Errors.validation([{ path: "plan", message: "Unknown plan" }]);
      throw e;
    }
  });
  r.patch("/tenants/:id", async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, patchTenantSchema);
    try {
      const [ok] = await db<{ saUpdateTenant: boolean }[]>`SELECT sa_update_tenant(${c.get("adminId")}, ${id}, ${body.name ?? null}, ${body.plan ?? null})`;
      if (!ok?.saUpdateTenant) throw Errors.notFound("Tenant not found");
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "plan", message: "Unknown plan" }]);
      throw e;
    }
    const [t] = await db<TenantRow[]>`SELECT * FROM sa_get_tenant(${id})`;
    return c.json(tdto(t!));
  });
  const setStatus = (status: "active" | "suspended" | "deleted") => async (c: import("hono").Context<AdminEnv>) => {
    const id = parseId(c);
    const [res] = await db<{ saSetTenantStatus: string }[]>`SELECT sa_set_tenant_status(${c.get("adminId")}, ${id}, ${status})`;
    if (res?.saSetTenantStatus === "not_found") throw Errors.notFound("Tenant not found");
    if (res?.saSetTenantStatus === "expired") throw Errors.conflict("Deletion grace period has passed");
    const [t] = await db<TenantRow[]>`SELECT * FROM sa_get_tenant(${id})`;
    return c.json(tdto(t!));
  };
  r.post("/tenants/:id/suspend", setStatus("suspended"));
  r.post("/tenants/:id/unsuspend", setStatus("active"));
  r.post("/tenants/:id/restore", setStatus("active"));
  r.delete("/tenants/:id", setStatus("deleted"));

  // ---- plans
  r.get("/plans", async (c) => {
    const rows = await db<{ key: string; name: string; metric: string | null; limitValue: string | null }[]>`
      SELECT p.key, p.name, l.metric, l.limit_value FROM plans p LEFT JOIN plan_limits l ON l.plan_key = p.key ORDER BY p.key, l.metric`;
    const plans = new Map<string, { key: string; name: string; limits: Record<string, number | null> }>();
    for (const x of rows) {
      const p = plans.get(x.key) ?? { key: x.key, name: x.name, limits: {} };
      if (x.metric) p.limits[x.metric] = x.limitValue === null ? null : Number(x.limitValue);
      plans.set(x.key, p);
    }
    return c.json({ items: [...plans.values()] });
  });
  r.put("/plans/:key/limits/:metric", async (c) => {
    const key = planKey.safeParse(c.req.param("key"));
    const metric = z.enum(LIMIT_METRICS).safeParse(c.req.param("metric"));
    if (!key.success || !metric.success) throw Errors.notFound();
    const body = await parseBody(c, z.strictObject({ limit: z.number().int().min(0).nullable() }));
    try {
      await db`SELECT sa_set_plan_limit(${c.get("adminId")}, ${key.data}, ${metric.data}, ${body.limit})`;
    } catch (e) {
      if (isFkViolation(e)) throw Errors.notFound("Plan not found");
      throw e;
    }
    return c.json({ plan: key.data, metric: metric.data, limit: body.limit });
  });

  // ---- feature flags
  r.get("/feature-flags", async (c) => {
    const rows = await db<{ key: string; description: string; defaultEnabled: boolean }[]>`SELECT key, description, default_enabled FROM feature_flags ORDER BY key`;
    return c.json({ items: rows });
  });
  r.put("/feature-flags/:key", async (c) => {
    const key = flagKeySchema.safeParse(c.req.param("key"));
    if (!key.success) throw Errors.notFound();
    const body = await parseBody(c, z.strictObject({ description: z.string().max(500).default(""), defaultEnabled: z.boolean() }));
    await db`SELECT sa_upsert_flag(${c.get("adminId")}, ${key.data}, ${body.description}, ${body.defaultEnabled})`;
    return c.json({ key: key.data, ...body });
  });
  r.delete("/feature-flags/:key", async (c) => {
    const key = flagKeySchema.safeParse(c.req.param("key"));
    if (!key.success) throw Errors.notFound();
    const [x] = await db<{ saDeleteFlag: boolean }[]>`SELECT sa_delete_flag(${c.get("adminId")}, ${key.data})`;
    if (!x?.saDeleteFlag) throw Errors.notFound();
    return c.json({ ok: true as const });
  });
  r.get("/tenants/:id/flags", async (c) => {
    const id = parseId(c);
    const [flags, overrides] = await Promise.all([
      db<{ key: string; defaultEnabled: boolean }[]>`SELECT key, default_enabled FROM feature_flags ORDER BY key`,
      db<{ flagKey: string; enabled: boolean }[]>`SELECT * FROM sa_tenant_flag_overrides(${id})`,
    ]);
    const o = new Map(overrides.map((x) => [x.flagKey, x.enabled]));
    return c.json({ items: flags.map((f) => ({ key: f.key, defaultEnabled: f.defaultEnabled, override: o.get(f.key) ?? null, effective: o.get(f.key) ?? f.defaultEnabled })) });
  });
  r.put("/tenants/:id/flags/:key", async (c) => {
    const id = parseId(c);
    const key = flagKeySchema.safeParse(c.req.param("key"));
    if (!key.success) throw Errors.notFound();
    const body = await parseBody(c, z.strictObject({ enabled: z.boolean().nullable() })); // null clears the override
    const [x] = await db<{ saSetTenantFlag: boolean }[]>`SELECT sa_set_tenant_flag(${c.get("adminId")}, ${id}, ${key.data}, ${body.enabled})`;
    if (!x?.saSetTenantFlag) throw Errors.notFound("Tenant or flag not found");
    return c.json({ key: key.data, override: body.enabled });
  });

  r.get("/audit-logs", async (c) => {
    const q = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }));
    const rows = await db`SELECT * FROM sa_list_platform_audit(${q.limit}, ${q.offset})`;
    return c.json({ items: rows });
  });
  return r;
}
