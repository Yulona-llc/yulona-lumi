import { Hono } from "hono";
import type { AppEnv } from "../context";
import { bookingRoutes } from "./bookings";
import { calendlyRoutes } from "./calendly";
import { cannedRoutes } from "./canned";
import { opsRuntimeFromEnv, type OpsDeps, type OpsRuntime } from "./common";
import { handoffRoutes } from "./handoffs";
import { hubspotRoutes } from "./hubspot";
import { notificationRoutes } from "./notifications";
import { settingsRoutes } from "./settings";
import { tagRoutes } from "./tags";
import { ticketRoutes } from "./tickets";

export type { OpsRuntime };

/**
 * Mounts every route owned by the ops area (tickets, bookings/calendar, Needs Attention, availability,
 * business hours, canned responses, tags, notifications). Auth is applied per route (no `use("*")`), so the Google OAuth callback can live next to authenticated routes safely.
 */
export function registerOps(app: Hono<AppEnv>, deps: Omit<OpsDeps, "runtime"> & { runtime?: OpsRuntime }): void {
  const d: OpsDeps = { ...deps, runtime: deps.runtime ?? opsRuntimeFromEnv(deps.cfg) };
  const api = new Hono<AppEnv>();
  for (const sub of [settingsRoutes, cannedRoutes, tagRoutes, notificationRoutes, ticketRoutes, bookingRoutes, calendlyRoutes, hubspotRoutes, handoffRoutes]) api.route("/", sub(d));
  app.route("/api/v1", api);
}
