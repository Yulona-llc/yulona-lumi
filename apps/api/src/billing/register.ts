import type { Hono } from "hono";
import type { Db } from "@yulona/db";
import { createProvidersFromEnv, type Providers } from "@yulona/providers";
import type { Logger } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { adminOpsRoutes } from "./admin";
import { billingRoutes } from "./routes";

export { impersonationAudit } from "./admin";

export interface BillingAdminDeps { cfg: Config; db: Db; log: Logger; providers?: Providers }

/** Mount AFTER registerPlatform (admin ops share the /admin prefix; per-route auth keeps order irrelevant). */
export function registerBillingAdmin(app: Hono<AppEnv>, { cfg, db, log, providers }: BillingAdminDeps) {
  const p = providers ?? createProvidersFromEnv();
  if (cfg.billingEnabled) app.route("/api/v1", billingRoutes({ cfg, db, providers: p, log }));
  if (cfg.superAdminEnabled) app.route("/api/v1", adminOpsRoutes({ cfg, db }));
}
