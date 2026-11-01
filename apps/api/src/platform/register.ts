import type { Hono } from "hono";
import type { Db } from "@yulona/db";
import type { Logger } from "@yulona/shared";
import { createProvidersFromEnv, type Providers } from "@yulona/providers";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import type { RateLimiter } from "../ratelimit";
import { agentRoutes } from "../routes/agents";
import { apiKeyInfoRoutes, apiKeyRoutes } from "../routes/api-keys";
import { auditRoutes } from "../routes/audit";
import { flagRoutes } from "../routes/flags";
import { tenantRoutes } from "../routes/tenants";
import { userRoutes } from "../routes/users";

export interface PlatformDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  log: Logger;
  providers?: Providers;
}

/** Mounts platform routes: tenant, users/invitations, agents, api keys, audit logs, flags. */
export function registerPlatform(app: Hono<AppEnv>, { cfg, db, limiter, log, providers }: PlatformDeps) {
  const p = providers ?? createProvidersFromEnv();
  app.route("/api/v1", userRoutes({ cfg, db, limiter, providers: p, log }));
  app.route("/api/v1", tenantRoutes({ cfg, db }));
  app.route("/api/v1", agentRoutes({ cfg, db }));
  app.route("/api/v1", apiKeyRoutes({ cfg, db }));
  app.route("/api/v1", apiKeyInfoRoutes({ db, limiter }));
  app.route("/api/v1", auditRoutes({ cfg, db }));
  app.route("/api/v1", flagRoutes({ cfg, db }));
}
