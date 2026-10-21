import type { MiddlewareHandler } from "hono";
import type { Db } from "@yulona/db";
import type { AppEnv } from "./context";
import { Errors } from "./errors";
import { verifyAccessToken } from "./security";

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
    }
  }
  await next();
};
