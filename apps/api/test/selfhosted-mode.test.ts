import { describe, expect, test } from "bun:test";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { MemoryRateLimiter } from "../src/ratelimit";

const env = { DATABASE_URL: "postgres://x:y@localhost/db", JWT_SECRET: "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W" };

describe("DEPLOYMENT_MODE", () => {
  test("saas default keeps billing", () => {
    const c = loadConfig(env);
    expect([c.deploymentMode, c.billingEnabled]).toEqual(["saas", true]);
  });
  test("selfhosted: no billing and no public signup", () => {
    const c = loadConfig({ ...env, DEPLOYMENT_MODE: "selfhosted", ALLOW_PUBLIC_SIGNUP: "true" });
    expect([c.billingEnabled, c.allowPublicSignup]).toEqual([false, false]);
    expect("superAdminEnabled" in c).toBe(false); // platform administration lives in apps/admin-api
  });
  test("selfhosted routes are not mounted (404 before auth)", async () => {
    const cfg = loadConfig({ ...env, DEPLOYMENT_MODE: "selfhosted" });
    const app = createApp({ cfg, db: {} as never, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent", service: "t" }) });
    expect((await app.request("/api/v1/billing")).status).toBe(404);
    expect((await app.request("/api/v1/admin/tenants")).status).toBe(404);
    expect((await app.request("/api/v1/admin/auth/login", { method: "POST" })).status).toBe(404);
    const saas = createApp({ cfg: loadConfig(env), db: {} as never, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent", service: "t" }) });
    expect((await saas.request("/api/v1/billing")).status).toBe(401);
  });
});
