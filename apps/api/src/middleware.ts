import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { Logger } from "@yulona/shared";
import type { Config } from "./config";
import type { AppEnv } from "./context";
import { AppError, Errors } from "./errors";
import type { RateLimiter } from "./ratelimit";
import { safeEqual, sha256, verifyAccessToken } from "./security";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function errorResponse(c: Context, status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
  return c.json(
    { error: { code, message, requestId: c.get("requestId") ?? "unknown", ...(details === undefined ? {} : { details }) } },
    status as 400,
    headers,
  );
}

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Rightmost entry = the address our (single) trusted proxy saw; leftmost is client-controlled.
    const xff = c.req.header("x-forwarded-for");
    const last = xff?.split(",").pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const resolveIp = (trustProxy: boolean): MiddlewareHandler<AppEnv> => async (c, next) => {
  c.set("ip", clientIp(c, trustProxy));
  await next();
};

export const requestLogger = (log: Logger): MiddlewareHandler<AppEnv> => async (c, next) => {
  const start = performance.now();
  await next();
  const auth = c.get("auth");
  log.info("request", {
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path, // never the query string
    status: c.res.status,
    ms: Math.round(performance.now() - start),
    ip: c.get("ip"),
    tenantId: auth?.tenantId,
    userId: auth?.userId,
  });
};

/** Throws a 429 AppError when the limit is exceeded. */
export async function enforceLimit(limiter: RateLimiter, key: string, rule: { limit: number; windowMs: number }): Promise<void> {
  const r = await limiter.hit(key, rule.limit, rule.windowMs);
  if (!r.allowed) throw Errors.rateLimited(r.retryAfterSec);
}

export const globalRateLimit = (limiter: RateLimiter, cfg: Config): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (c.req.path === "/healthz" || c.req.path === "/readyz") return next();
  // Provider webhooks come from shared provider IPs; they are signature-verified and limited per connection instead.
  if (c.req.path.startsWith("/api/v1/webhooks/channels/")) return next();
  await enforceLimit(limiter, `g:${c.get("ip")}`, cfg.rateLimits.global);
  await next();
};

/**
 * Tenancy resolver (layer 1): verifies the access JWT and sets the tenant from the signed claim only.
 * Nothing in the request body, query or path can influence tenantId.
 */
function parseBasic(header: string | undefined): { user: string; password: string } | null {
  const m = header && /^Basic\s+([A-Za-z0-9+/=_-]+)$/.exec(header);
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i <= 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/** HTTP basic auth for the OpenAPI reference. Returns 401 instead of throwing so the browser prompt survives the error handler. */
export function requireDocsAuth(username: string, password: string, limiter: RateLimiter, rule: { limit: number; windowMs: number }): MiddlewareHandler<AppEnv> {
  const userHash = sha256(username);
  const passHash = sha256(password);
  return async (c, next) => {
    await enforceLimit(limiter, `docs:${c.get("ip")}`, rule);
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    const parsed = parseBasic(c.req.header("authorization"));
    const userOk = safeEqual(sha256(parsed?.user ?? "\0"), userHash);
    const passOk = safeEqual(sha256(parsed?.password ?? "\0"), passHash);
    if (!userOk || !passOk) {
      return c.text("Authentication required", 401, { "WWW-Authenticate": 'Basic realm="Yulona API docs", charset="UTF-8"' });
    }
    await next();
  };
}

export const requireAuth = (cfg: Config): MiddlewareHandler<AppEnv> => async (c, next) => {
  const h = c.req.header("authorization");
  const m = h && /^Bearer ([A-Za-z0-9._-]+)$/.exec(h);
  if (!m) throw Errors.unauthorized();
  const claims = await verifyAccessToken(cfg.jwtSecret, m[1]!);
  if (!claims) throw Errors.unauthorized("Invalid or expired token");
  c.set("auth", { userId: claims.sub, tenantId: claims.tid, role: claims.role, ...(claims.imp ? { impersonatorId: claims.imp, impersonationSessionId: claims.ims } : {}) });
  await next();
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
