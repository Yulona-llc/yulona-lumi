import { Hono } from "hono";
import type { Db } from "@yulona/db";
import type { AppEnv } from "../context";
import type { RateLimiter } from "../ratelimit";

export function healthRoutes(db: Db, limiter: RateLimiter & { ping?: () => Promise<boolean> }, redisConfigured: boolean) {
  const r = new Hono<AppEnv>();
  r.get("/healthz", (c) => c.json({ status: "ok" }));
  r.get("/readyz", async (c) => {
    const checks: Record<string, "ok" | "fail"> = {};
    try {
      await Promise.race([db`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]);
      checks.db = "ok";
    } catch {
      checks.db = "fail";
    }
    if (redisConfigured && limiter.ping) checks.redis = (await limiter.ping()) ? "ok" : "fail";
    const ok = Object.values(checks).every((v) => v === "ok");
    return c.json({ status: ok ? "ok" : "unavailable", checks }, ok ? 200 : 503);
  });
  return r;
}
