import { describe, expect, test } from "bun:test";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { MemoryRateLimiter } from "../src/ratelimit";

const env = { DATABASE_URL: "postgres://x:y@localhost/db", JWT_SECRET: "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W" };

describe("DEPLOYMENT_MODE", () => {
  test("saas default keeps super-admin + billing", () => {
    const c = loadConfig(env);
    expect([c.deploymentMode, c.superAdminEnabled, c.billingEnabled]).toEqual(["saas", true, true]);
  });
  test("selfhosted: no billing, no super-admin, no public signup unless super-admin explicitly enabled", () => {
    const c = loadConfig({ ...env, DEPLOYMENT_MODE: "selfhosted", ALLOW_PUBLIC_SIGNUP: "true" });
    expect([c.superAdminEnabled, c.billingEnabled, c.allowPublicSignup]).toEqual([false, false, false]);
    expect(loadConfig({ ...env, DEPLOYMENT_MODE: "selfhosted", SUPER_ADMIN_ENABLED: "true" }).superAdminEnabled).toBe(true);
  });
  test("selfhosted routes are not mounted (404 before auth)", async () => {
    const cfg = loadConfig({ ...env, DEPLOYMENT_MODE: "selfhosted" });
    const app = createApp({ cfg, db: {} as never, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent", service: "t" }) });
    expect((await app.request("/api/v1/billing")).status).toBe(404);
    expect((await app.request("/api/v1/admin/tenants")).status).toBe(404);
    const saas = createApp({ cfg: loadConfig(env), db: {} as never, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent", service: "t" }) });
    expect((await saas.request("/api/v1/billing")).status).toBe(401);
  });
});
