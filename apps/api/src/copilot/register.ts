import { Hono } from "hono";
import type { AiPorts } from "@yulona/ai-runtime";
import type { Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import type { RateLimiter } from "../ratelimit";
import { copilotRoutes } from "./routes";
import { lazyPorts } from "./ports";
import { onboardingRoutes } from "./onboarding";
import { overviewRoutes } from "./overview";

export interface CopilotRegisterDeps { cfg: Config; db: Db; limiter: RateLimiter; ports?: AiPorts }

/** Auth is per route (guard on each route, no `use("*")`). Register BEFORE `meRoutes` in app.ts. */
export function registerCopilot(app: Hono<AppEnv>, { cfg, db, limiter, ports }: CopilotRegisterDeps): void {
  const p = lazyPorts(cfg, db, ports);
  const api = new Hono<AppEnv>();
  api.route("/", onboardingRoutes({ cfg, db, ports: p }));
  api.route("/", copilotRoutes({ cfg, db, limiter, ports: p }));
  api.route("/", overviewRoutes({ cfg, db }));
  app.route("/api/v1", api);
}
