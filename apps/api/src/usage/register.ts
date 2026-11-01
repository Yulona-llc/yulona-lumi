import type { Hono } from "hono";
import type { Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { usageRoutes } from "./routes";

/** Tenant usage/credits are always mounted. Platform administration (rates, packs, profiles, grants) lives in apps/admin-api. */
export function registerUsage(app: Hono<AppEnv>, { cfg, db }: { cfg: Config; db: Db }) {
  app.route("/api/v1", usageRoutes({ cfg, db }));
}
