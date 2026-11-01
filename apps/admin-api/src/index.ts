import { closeDb, createDb } from "@yulona/db";
import { createLogger } from "@yulona/shared";
import { createAdminApp } from "./app";
import { loadConfig } from "./config";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit";

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const log = createLogger({ level: cfg.logLevel, service: "admin-api" });
const db = createDb(cfg.databaseUrl, { max: cfg.dbPoolMax, applicationName: "yulona-admin-api" });
const limiter: RateLimiter = cfg.redisUrl ? new RedisRateLimiter(cfg.redisUrl, log) : new MemoryRateLimiter();
const app = createAdminApp({ cfg, db, limiter, log });

const server = Bun.serve({ port: cfg.port, fetch: app.fetch, idleTimeout: 30, maxRequestBodySize: cfg.bodyLimitBytes, development: false });
log.info("admin-api listening", { port: server.port, env: cfg.env, rateLimiter: cfg.redisUrl ? "redis" : "memory", twoFactorRequired: cfg.require2fa, ipAllowList: cfg.allowedCidrs.length });
if (!cfg.encryptionKey) log.warn("ENCRYPTION_KEY is not set: two-factor authentication and LLM provider keys will return 503");
if (cfg.allowedCidrs.length === 0) log.warn("ADMIN_ALLOWED_CIDRS is empty: any IP may reach the admin API (restrict it at the proxy or set the allow-list)");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await server.stop();
    limiter.close();
    await closeDb(db, 10);
    process.exit(0);
  } catch (e) {
    log.error("shutdown error", { err: (e as Error).message });
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: String(e) }));
