import type { Hono } from "hono";
import type { AppEnv } from "../context";
import { contactRoutes } from "../routes/contacts";
import { conversationRoutes } from "../routes/conversations";
import { publicWidgetRoutes } from "../routes/public-widget";
import { realtimeRoutes } from "../routes/realtime";
import { widgetRoutes } from "../routes/widgets";
import { aiStateRoutes } from "./ai-state";
import type { ConvDeps } from "./common";

/** Mounts every route owned by the conversations area (single registration point for app.ts). */
export function registerConversations(app: Hono<AppEnv>, deps: ConvDeps): void {
  app.route("/api/v1", conversationRoutes(deps));
  app.route("/api/v1", aiStateRoutes(deps));
  app.route("/api/v1", contactRoutes(deps));
  app.route("/api/v1", widgetRoutes(deps));
  app.route("/api/v1", realtimeRoutes(deps));
  // Canonical path (reachable through the `/api/*` reverse-proxy rule) plus the short alias from the brief.
  const pub = publicWidgetRoutes(deps);
  app.route("/api/v1/public/widget", pub);
  app.route("/public/widget", pub);
}
