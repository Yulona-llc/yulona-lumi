import type { Hono } from "hono";
import type { Db } from "@yulona/db";
import { createProvidersFromEnv, type Providers } from "@yulona/providers";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import type { RateLimiter } from "../ratelimit";
import { gdprRoutes } from "./gdpr";
import { publicApiRoutes } from "./public-api";
import { retentionRoutes } from "./retention";
import { webhookRoutes } from "./webhooks";

/**
 * Mounts the integrations area: outbound webhooks, GDPR export/erasure, retention policy (JWT, admin+)
 * and the API-key public API under `/api/v1/public-api`. Register BEFORE `meRoutes` in app.ts.
 */
export function registerIntegrations(app: Hono<AppEnv>, deps: { cfg: Config; db: Db; limiter: RateLimiter; providers?: Providers }) {
  const d = { ...deps, providers: deps.providers ?? createProvidersFromEnv() };
  app.route("/api/v1", webhookRoutes(d));
  app.route("/api/v1", gdprRoutes(d));
  app.route("/api/v1", retentionRoutes(d));
  app.route("/api/v1/public-api", publicApiRoutes(d));
}
