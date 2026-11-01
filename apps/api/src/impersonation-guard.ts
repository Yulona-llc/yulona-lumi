import type { MiddlewareHandler } from "hono";
import { AuditLogRepository, withTenant, type Db } from "@yulona/db";
import type { AppEnv } from "./context";
import { Errors } from "./errors";
import { verifyAccessToken } from "./security";

export const IMPERSONATION_TTL_S = 900;

/** True unless the (impersonation) session behind the token has been ended/expired/deleted. */
export async function impersonationSessionActive(db: Db, sessionId: string, tenantId: string): Promise<boolean> {
  const [r] = await db<{ active: boolean }[]>`SELECT impersonation_session_active(${sessionId}::uuid, ${tenantId}::uuid) AS active`;
  return !!r?.active;
}
export async function tenantActive(db: Db, tenantId: string): Promise<boolean> {
  const [r] = await db<{ active: boolean }[]>`SELECT tenant_is_active(${tenantId}::uuid) AS active`;
  return !!r?.active;
}

/**
 * Revocation checks for access tokens, run before any route (only for validly signed tokens, so forged claims cost nothing):
 *  - the tenant must still be active (suspension/deletion takes effect immediately, not after the 15 min token lifetime)
 *  - impersonation tokens are valid only while their session exists, is not ended and has not expired
 * One primary-key lookup per authenticated request; deliberately uncached so revocation is instantaneous.
 */
export const impersonationGuard = (db: Db, secret: string): MiddlewareHandler<AppEnv> => async (c, next) => {
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(c.req.header("authorization") ?? "");
  if (m) {
    const claims = await verifyAccessToken(secret, m[1]!);
    if (claims) {
      if (!(await tenantActive(db, claims.tid))) throw Errors.unauthorized("Workspace is not active");
      if (claims.ims && !(await impersonationSessionActive(db, claims.ims, claims.tid))) throw Errors.unauthorized("Impersonation session ended");
      // read-only impersonation (platform support): the token may only read
      if (claims.ro && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) throw Errors.forbidden("This impersonation session is read-only");
    }
  }
  await next();
};

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
