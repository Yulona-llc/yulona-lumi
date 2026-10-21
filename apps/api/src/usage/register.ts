import type { Hono } from "hono";
import type { Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { adminCreditsRoutes } from "./admin";
import { usageRoutes } from "./routes";

/** Tenant usage/credits are always mounted; the admin (platform) routes follow `superAdminEnabled`. Auth is per route. */
export function registerUsage(app: Hono<AppEnv>, { cfg, db }: { cfg: Config; db: Db }) {
  app.route("/api/v1", usageRoutes({ cfg, db }));
  if (cfg.superAdminEnabled) app.route("/api/v1", adminCreditsRoutes({ cfg, db }));
}
