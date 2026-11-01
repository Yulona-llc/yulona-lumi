import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Deps } from "./context";
import { AppError } from "./errors";
import { adminRateLimit, authenticate, errorResponse, ipAllowList, requestId, requestLogger, requireRoles, resolveIp, securityHeaders } from "./middleware";
import type { AdminEnv, Registrar } from "./route";
import { registerAll } from "./routes";

export const API_PREFIX = "/api/v1";

export function createAdminApp(deps: Deps) {
  const { cfg, db, log } = deps;
  const app = new Hono<AdminEnv>();

  app.use("*", requestId());
  app.use("*", resolveIp(cfg.trustProxy));
  app.use("*", requestLogger(log));
  app.use("*", ipAllowList(cfg));
  app.use("*", securityHeaders(cfg));
  app.use("*", cors({
    origin: (origin) => (origin === cfg.webOrigin ? origin : null), // exactly one origin: the admin web app
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type", "X-Admin-Request", "X-Request-Id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Request-Id", "Retry-After", "Content-Disposition"],
    maxAge: 600,
  }));
  app.use("*", bodyLimit({ maxSize: cfg.bodyLimitBytes, onError: (c) => errorResponse(c, 413, "payload_too_large", "Request body too large") }));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    try {
      await db`SELECT 1`;
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  const registrar: Registrar = {
    route(meta, handler) {
      const mws = meta.roles === "public" ? [] : [authenticate(deps, meta), requireRoles(meta.roles), adminRateLimit(deps, meta)];
      for (const h of [...mws, handler]) app.on(meta.method, `${API_PREFIX}${meta.path}`, h);
    },
  };
  registerAll(registrar, deps);

  app.notFound((c) => errorResponse(c, 404, "not_found", "Not found"));
  app.onError((err, c) => {
    if (err instanceof AppError) return errorResponse(c, err.status, err.code, err.message, err.details, err.headers);
    log.error("unhandled error", { requestId: c.get("requestId"), path: c.req.path, err: err.message, stack: err.stack });
    return errorResponse(c, 500, "internal_error", "Internal server error");
  });
  return app;
}
