import type { Hono } from "hono";
import type { Db } from "@yulona/db";
import { createProvidersFromEnv, type Providers } from "@yulona/providers";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import type { RateLimiter } from "../ratelimit";
import { storageOrDatabase } from "@yulona/integrations";
import { gdprRoutes } from "./gdpr";
import { publicApiRoutes } from "./public-api";
import { retentionRoutes } from "./retention";
import { webhookRoutes } from "./webhooks";

/**
 * Mounts the integrations area: outbound webhooks, GDPR export/erasure, retention policy (JWT, admin+)
 * and the API-key public API under `/api/v1/public-api`. Register BEFORE `meRoutes` in app.ts.
 */
export function registerIntegrations(app: Hono<AppEnv>, deps: { cfg: Config; db: Db; limiter: RateLimiter; providers?: Providers }) {
  // Without a bucket (S3_BUCKET) export files live in Postgres: the API and the worker are different processes and cannot share memory.
  const providers = deps.providers ?? (() => { const p = createProvidersFromEnv(); return { ...p, storage: storageOrDatabase(p.storage, deps.db) }; })();
  const d = { ...deps, providers };
  app.route("/api/v1", webhookRoutes(d));
  app.route("/api/v1", gdprRoutes(d));
  app.route("/api/v1", retentionRoutes(d));
  app.route("/api/v1/public-api", publicApiRoutes(d));
}
