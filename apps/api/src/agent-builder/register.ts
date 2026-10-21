import { Hono } from "hono";
import type { AppEnv } from "../context";
import { agentBuilderRoutes, type AgentBuilderDeps } from "./routes";

/** Auth is per route (no `use("*")`). Register BEFORE `meRoutes` in app.ts. */
export function registerAgentBuilder(app: Hono<AppEnv>, deps: AgentBuilderDeps): void {
  app.route("/api/v1", agentBuilderRoutes(deps));
}
