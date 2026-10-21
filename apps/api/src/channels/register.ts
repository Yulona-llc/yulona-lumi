import type { Hono } from "hono";
import { createDefaultRegistry, type ChannelRegistry } from "@yulona/channels";
import type { Logger } from "@yulona/shared";
import type { AppEnv } from "../context";
import type { ConvDeps } from "../conversations/common";
import { channelRoutes } from "./routes";
import { channelWebhookRoutes } from "./webhooks";

/** Mounts connection management + public webhook receivers (single registration point for app.ts). */
export function registerChannels(app: Hono<AppEnv>, deps: Omit<ConvDeps, "realtime"> & { log: Logger; registry?: ChannelRegistry }): void {
  const registry = deps.registry ?? createDefaultRegistry();
  app.route("/api/v1/webhooks/channels", channelWebhookRoutes({ ...deps, registry }));
  app.route("/api/v1", channelRoutes({ ...deps, registry }));
}
