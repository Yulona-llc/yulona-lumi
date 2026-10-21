import { Hono } from "hono";
import type { Db } from "@yulona/db";
import type { Resolver } from "@yulona/ai-runtime";
import type { Logger } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import type { RateLimiter } from "../ratelimit";
import { connectionRoutes } from "./connections";
import { toolRunRoutes } from "./runs";
import { toolTestRoutes } from "./test-endpoint";

/** Test hooks: point outbound calls at a local server (production uses the real network + DNS). */
export interface ToolsRuntime {
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
}
export interface ToolsDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  log: Logger;
  runtime: ToolsRuntime;
}

/** Tool connections + the tool test endpoint. Auth is per route (no `use("*")`). Register BEFORE `meRoutes` in app.ts. */
export function registerTools(app: Hono<AppEnv>, deps: Omit<ToolsDeps, "runtime"> & { runtime?: ToolsRuntime }): void {
  const d: ToolsDeps = { ...deps, runtime: deps.runtime ?? {} };
  const api = new Hono<AppEnv>();
  api.route("/", connectionRoutes(d));
  api.route("/", toolTestRoutes(d));
  api.route("/", toolRunRoutes(d));
  app.route("/api/v1", api);
}
