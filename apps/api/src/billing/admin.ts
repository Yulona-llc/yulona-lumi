// Super-admin ops: tenant detail/usage, platform analytics, system health, impersonation, audit export.
// Auth is applied per route (never `use("*")`) so mounting order cannot change which routes are protected.
import { Hono, type MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import { z } from "zod";
import { AuditLogRepository, withTenant, type Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { LIMIT_METRICS, checkLimit } from "../platform/limits";
import { parseId, parseQuery } from "../platform/util";
import { signAccessToken } from "../security";
import { toCsv } from "./csv";

type AdminEnv = { Variables: AppEnv["Variables"] & { adminId: string } };
const adminSecret = (cfg: Config) => `${cfg.jwtSecret}:platform-admin`; // same realm key as routes/tenants.ts
export const IMPERSONATION_TTL_S = 900;

export const requireAdmin = (cfg: Config, db: Db): MiddlewareHandler<AdminEnv> => async (c, next) => {
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

export function adminOpsRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AdminEnv>();
  const guard = requireAdmin(cfg, db);
  const days = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

  const tenantLimits = async (tenantId: string) => {
    const limits = await Promise.all(LIMIT_METRICS.map((m) => checkLimit(db, tenantId, m, 0)));
    return limits.map((l) => ({ metric: l.metric, limit: l.limit, used: l.used, warning: l.warning }));
  };

  r.get("/admin/tenants/:id/detail", guard, async (c) => {
    const id = parseId(c);
    const [t] = await db<{ id: string; name: string; status: string; planKey: string; deletedAt: Date | null; createdAt: Date }[]>`
      SELECT id, name, status, plan_key, deleted_at, created_at FROM sa_get_tenant(${id})`;
    const [d] = await db<{ saTenantDetail: Record<string, unknown> | null }[]>`SELECT sa_tenant_detail(${id})`;
    if (!t || !d?.saTenantDetail) throw Errors.notFound("Tenant not found");
    const { counts, lastActivityAt, billing } = d.saTenantDetail as { counts: Record<string, number>; lastActivityAt: string | null; billing: Record<string, unknown> | null };
    return c.json({
      tenant: { id: t.id, name: t.name, status: t.status, plan: t.planKey, deletedAt: t.deletedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() },
      billing: billing ?? null,
      limits: await tenantLimits(id),
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
    });
  });

  r.get("/admin/tenants/:id/usage", guard, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, days);
    const [t] = await db`SELECT id FROM sa_get_tenant(${id})`;
    if (!t) throw Errors.notFound("Tenant not found");
    const rows = await db<{ day: Date; metric: string; value: string }[]>`SELECT * FROM sa_tenant_usage(${id}, ${q.days})`;
    return c.json({
      series: rows.map((x) => ({ day: x.day.toISOString().slice(0, 10), metric: x.metric, value: Number(x.value) })),
      limits: await tenantLimits(id),
    });
  });

  r.get("/admin/analytics", guard, async (c) => {
    const [a] = await db<{ saPlatformAnalytics: Record<string, unknown> }[]>`SELECT sa_platform_analytics()`;
    return c.json(a!.saPlatformAnalytics);
  });

  r.get("/admin/health", guard, async (c) => {
    const t0 = performance.now();
    let dbOk = true;
    try { await db`SELECT 1`; } catch { dbOk = false; }
    const latencyMs = Math.round(performance.now() - t0);
    let queue = { queued: 0, running: 0, dead: 0, oldestQueuedAgeSec: null as number | null };
    let hb: { lastHeartbeatAt: string | null; heartbeatAgeSec: number | null } = { lastHeartbeatAt: null, heartbeatAgeSec: null };
    if (dbOk) {
      const [h] = await db<{ saSystemHealth: { queue: typeof queue; lastHeartbeatAt: string | null; heartbeatAgeSec: number | null } }[]>`SELECT sa_system_health()`;
      queue = h!.saSystemHealth.queue;
      hb = h!.saSystemHealth;
    }
    const workerOk = hb.heartbeatAgeSec !== null && hb.heartbeatAgeSec < 120;
    const status = !dbOk ? "down" : !workerOk || queue.dead > 0 ? "degraded" : "ok";
    return c.json({
      status, db: { ok: dbOk, latencyMs },
      queue: { queued: Number(queue.queued), running: Number(queue.running), dead: Number(queue.dead), oldestQueuedAgeSec: queue.oldestQueuedAgeSec },
      worker: { lastHeartbeatAt: hb.lastHeartbeatAt ? new Date(hb.lastHeartbeatAt).toISOString() : null, ageSec: hb.heartbeatAgeSec, ok: workerOk },
    });
  });

  // ---- impersonation
  r.post("/admin/tenants/:id/impersonate", guard, async (c) => {
    const tenantId = parseId(c);
    const body = await parseBody(c, z.strictObject({ reason: z.string().trim().min(5).max(500), userId: z.uuid().optional() }));
    const adminId = c.get("adminId");
    const [s] = await db<{ rStatus: string; rSession: string; rUser: string; rRole: "admin" | "agent" | "viewer"; rEmail: string; rName: string; rTenantName: string; rExpires: Date }[]>`
      SELECT * FROM sa_start_impersonation(${adminId}, ${tenantId}, ${body.userId ?? null}, ${body.reason}, ${IMPERSONATION_TTL_S})`;
    if (!s || s.rStatus === "not_found") throw Errors.notFound("Tenant not found");
    if (s.rStatus === "tenant_inactive") throw Errors.conflict("Tenant is not active");
    if (s.rStatus === "user_not_found") throw Errors.notFound("User not found in this tenant");
    const accessToken = await signAccessToken(cfg.jwtSecret, {
      userId: s.rUser, tenantId, role: s.rRole, ttlSeconds: IMPERSONATION_TTL_S, impersonation: { adminId, sessionId: s.rSession },
    });
    return c.json({
      accessToken, expiresIn: IMPERSONATION_TTL_S, sessionId: s.rSession,
      user: { id: s.rUser, email: s.rEmail, name: s.rName, role: s.rRole }, tenant: { id: tenantId, name: s.rTenantName },
    }, 201);
  });

  r.post("/admin/impersonation/:sessionId/end", guard, async (c) => {
    const [x] = await db<{ saEndImpersonation: boolean }[]>`SELECT sa_end_impersonation(${c.get("adminId")}, ${parseId(c, "sessionId")})`;
    if (!x?.saEndImpersonation) throw Errors.notFound("Session not found or already ended");
    return c.json({ ok: true as const });
  });

  // ---- platform audit export
  r.get("/admin/audit-logs/export", guard, async (c) => {
    const q = parseQuery(c, z.object({ format: z.enum(["csv", "json"]).default("csv") }));
    const rows = await db<{ id: string; adminId: string | null; action: string; tenantId: string | null; metadata: unknown; createdAt: Date }[]>`
      SELECT * FROM sa_export_platform_audit(50000)`;
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="platform-audit-${stamp}.${q.format}"` };
    if (q.format === "json") {
      return new Response(JSON.stringify({ items: rows.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })) }), { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }
    return new Response(
      toCsv(["id", "createdAt", "adminId", "action", "tenantId", "metadata"], rows.map((x) => [x.id, x.createdAt.toISOString(), x.adminId, x.action, x.tenantId, x.metadata])),
      { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } },
    );
  });
  return r;
}

/**
 * Records every state-changing request made with an impersonation token in the tenant's audit log
 * (tenant side of "audit both sides"). Registered globally; a no-op for normal tokens.
 */
export const impersonationAudit = (db: Db): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  const a = c.get("auth");
  if (!a?.impersonatorId || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return;
  try {
    await withTenant(db, a.tenantId, (tx) => new AuditLogRepository(tx, a.tenantId).record({
      actorUserId: a.userId, action: "impersonation.request", resourceType: "http", resourceId: `${c.req.method} ${c.req.path}`.slice(0, 200),
      metadata: { impersonatorId: a.impersonatorId, sessionId: a.impersonationSessionId ?? null, status: c.res.status },
      ip: c.get("ip"), requestId: c.get("requestId"),
    }));
  } catch { /* never fail the response because the audit write failed; the request log still has it */ }
};
