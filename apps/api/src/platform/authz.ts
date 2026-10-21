import type { MiddlewareHandler } from "hono";
import type { Role } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";

export const ROLE_RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };
export const hasMinRole = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

/** Must run after `requireAuth`. Allows only the listed roles. */
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const a = c.get("auth");
  if (!a) throw Errors.unauthorized();
  if (!roles.includes(a.role)) throw Errors.forbidden("Insufficient role");
  await next();
};

/** Must run after `requireAuth`. Allows `min` and anything above it (viewer < agent < admin < owner). */
export const requireMinRole = (min: Role): MiddlewareHandler<AppEnv> => async (c, next) => {
  const a = c.get("auth");
  if (!a) throw Errors.unauthorized();
  if (!hasMinRole(a.role, min)) throw Errors.forbidden("Insufficient role");
  await next();
};

/** Read-only roles (viewer) may only issue GET/HEAD/OPTIONS; every state-changing method needs `min` (default agent). */
export const requireWriteRole = (min: Role = "agent"): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  return requireMinRole(min)(c, next);
};
