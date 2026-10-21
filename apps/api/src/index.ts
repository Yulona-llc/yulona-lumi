import { closeDb, createDb } from "@yulona/db";
import { loadLicenseStatus } from "@yulona/license";
import { createLogger } from "@yulona/shared";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createRealtime } from "./realtime/service";
import { wsServerOptions } from "./realtime/ws";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit";

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const log = createLogger({ level: cfg.logLevel, service: "api" });
const db = createDb(cfg.databaseUrl, { max: cfg.dbPoolMax, applicationName: "yulona-api" });
const limiter: RateLimiter = cfg.redisUrl ? new RedisRateLimiter(cfg.redisUrl, log) : new MemoryRateLimiter();
const realtime = createRealtime({ db, log, redisUrl: cfg.redisUrl });
const app = createApp({ cfg, db, limiter, log, realtime });
void realtime.start();

const server = Bun.serve({
  port: cfg.port,
  fetch: app.fetch,
  websocket: wsServerOptions,
  idleTimeout: 30,
  maxRequestBodySize: cfg.bodyLimitBytes,
  development: false,
});
if (cfg.deploymentMode === "selfhosted") {
  const lic = loadLicenseStatus(); // offline verification only; never phones home
  log.info("self-hosted license", lic.state === "valid" ? { state: lic.state, customer: lic.claims.customer, seats: lic.claims.seats, daysLeft: lic.daysLeft } : { state: lic.state, reason: lic.state === "invalid" ? lic.reason : undefined });
}
log.info("api listening", { port: server.port, env: cfg.env, rateLimiter: cfg.redisUrl ? "redis" : "memory" });
if (!cfg.encryptionKey) log.warn("ENCRYPTION_KEY is not set: channel connections, webhooks and calendar connect will return 503");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  const force = setTimeout(() => {
    log.error("forced exit after timeout");
    process.exit(1);
  }, 15_000);
  force.unref();
  try {
    await realtime.stop();
    await server.stop(); // stop accepting, drain in-flight
    limiter.close();
    await closeDb(db, 10);
    log.info("shutdown complete");
    process.exit(0);
  } catch (e) {
    log.error("shutdown error", { err: (e as Error).message });
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: String(e) }));
