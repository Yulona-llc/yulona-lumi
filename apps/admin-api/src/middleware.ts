import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { Logger } from "@yulona/shared";
import type { Config } from "./config";
import { AppError, Errors } from "./errors";
import { buildAllowList } from "./ip";
import type { RateLimiter } from "./ratelimit";
import { verifyAdminToken } from "./security";
import type { AdminEnv, AdminPrincipal, AdminRole, RouteMeta } from "./route";
import { isWrite } from "./route";
import type { Deps } from "./context";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function errorResponse(c: Context, status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
  return c.json({ error: { code, message, requestId: c.get("requestId") ?? "unknown", ...(details === undefined ? {} : { details }) } }, status as 400, headers);
}

export const requestId = (): MiddlewareHandler<AdminEnv> => async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

/** Client IP: with TRUST_PROXY only the proxy-provided header (rightmost X-Forwarded-For, as in the customer API), else the socket. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
export const resolveIp = (trustProxy: boolean): MiddlewareHandler<AdminEnv> => async (c, next) => {
  c.set("ip", clientIp(c, trustProxy));
  await next();
};

/** ADMIN_ALLOWED_CIDRS enforced on every request except the health probes. */
export const ipAllowList = (cfg: Config): MiddlewareHandler<AdminEnv> => {
  const allowed = buildAllowList(cfg.allowedCidrs);
  return async (c, next) => {
    if (allowed && c.req.path !== "/healthz" && c.req.path !== "/readyz" && !allowed(c.get("ip"))) {
      return errorResponse(c, 403, "forbidden", "Forbidden");
    }
    await next();
  };
};

/** Strict headers on every response (this service returns JSON/CSV only). */
export const securityHeaders = (cfg: Config): MiddlewareHandler<AdminEnv> => async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (cfg.isProd) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
};

export const requestLogger = (log: Logger): MiddlewareHandler<AdminEnv> => async (c, next) => {
  const start = performance.now();
  await next();
  log.info("request", {
    requestId: c.get("requestId"), method: c.req.method, path: c.req.path, status: c.res.status,
    ms: Math.round(performance.now() - start), ip: c.get("ip"), adminId: c.get("admin")?.id,
  });
};

export async function enforceLimit(limiter: RateLimiter, key: string, rule: { limit: number; windowMs: number }): Promise<void> {
  const r = await limiter.hit(key, rule.limit, rule.windowMs);
  if (!r.allowed) throw Errors.rateLimited(r.retryAfterSec);
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Verifies the admin access token (ADMIN_JWT_SECRET only), then re-reads the admin from the DB on every request:
 * role changes, deactivation and session revocation take effect immediately.
 */
export const authenticate = ({ cfg, db }: Deps, meta: RouteMeta): MiddlewareHandler<AdminEnv> => async (c, next) => {
  const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(c.req.header("authorization") ?? "");
  if (!m) throw Errors.unauthorized();
  const claims = await verifyAdminToken(cfg.adminJwtSecret, m[1]!, "sa");
  if (!claims) throw Errors.unauthorized("Invalid or expired token");
  const [a] = await db<{ adminId: string; email: string; name: string; status: string; role: AdminRole; totpEnabled: boolean; mustChangePassword: boolean; sessionActive: boolean }[]>`
    SELECT * FROM sa_admin_context(${claims.sub}, ${claims.sid!})`;
  if (!a || a.status !== "active" || !a.sessionActive) throw Errors.unauthorized();
  const restricted: AdminPrincipal["restricted"] = a.mustChangePassword ? "password_change" : cfg.require2fa && !a.totpEnabled ? "two_factor_enrolment" : null;
  c.set("admin", { id: a.adminId, email: a.email, name: a.name, role: a.role, twoFactorEnabled: a.totpEnabled, restricted, sessionId: claims.sid! });
  if (restricted && !meta.allowRestricted) throw Errors.restricted(restricted);
  await next();
};

export const requireRoles = (roles: readonly AdminRole[]): MiddlewareHandler<AdminEnv> => async (c, next) => {
  if (!roles.includes(c.get("admin").role)) throw Errors.forbidden("Your role cannot do this");
  await next();
};

/** 30/min reads and 10/min writes per admin (env-tunable). */
export const adminRateLimit = ({ cfg, limiter }: Deps, meta: RouteMeta): MiddlewareHandler<AdminEnv> => async (c, next) => {
  const write = isWrite(meta);
  await enforceLimit(limiter, `adm:${write ? "w" : "r"}:${c.get("admin").id}`, write ? cfg.rateLimits.write : cfg.rateLimits.read);
  await next();
};
