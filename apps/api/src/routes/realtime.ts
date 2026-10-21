import { Hono } from "hono";
import { UsersRepository, withTenant } from "@yulona/db";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { verifyAccessToken } from "../security";
import { impersonationSessionActive, tenantActive } from "../impersonation-guard";
import type { ConvDeps } from "../conversations/common";
import { socketHandlers, upgradeWebSocket } from "../realtime/ws";

/** Dashboard realtime: `GET /api/v1/realtime/ws`. Token goes in the first frame, never the URL. */
export function realtimeRoutes({ cfg, db, realtime }: ConvDeps) {
  const r = new Hono<AppEnv>();
  const allowed = new Set(cfg.corsOrigins);
  r.get(
    "/realtime/ws",
    async (c, next) => {
      // A plain GET (no Upgrade header) used to reach the websocket helper and surface as a 500.
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: { code: "upgrade_required", message: "WebSocket upgrade required", requestId: c.get("requestId") } }, 426);
      const origin = c.req.header("origin");
      if (origin && !allowed.has(origin)) throw Errors.forbidden("Origin not allowed");
      await next();
    },
    upgradeWebSocket(() =>
      socketHandlers(realtime, async (token) => {
        const claims = await verifyAccessToken(cfg.jwtSecret, token);
        if (!claims) return null;
        if (!(await tenantActive(db, claims.tid))) return null;
        if (claims.ims && !(await impersonationSessionActive(db, claims.ims, claims.tid))) return null;
        const user = await withTenant(db, claims.tid, (tx) => new UsersRepository(tx, claims.tid).findById(claims.sub));
        if (!user || user.status !== "active") return null;
        return { kind: "agent", tenantId: claims.tid, userId: claims.sub };
      }),
    ),
  );
  return r;
}
