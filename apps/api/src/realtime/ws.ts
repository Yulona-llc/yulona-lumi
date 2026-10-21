import { createBunWebSocket } from "hono/bun";
import type { WSContext, WSEvents } from "hono/ws";
import { wsClientFrameSchema, type RealtimeEvent } from "@yulona/shared";
import type { Conn } from "./hub";
import type { Realtime } from "./service";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

/** Pass to Bun.serve: caps frame size and drops idle sockets (Bun auto-pings, so live clients stay open). */
export const wsServerOptions = { ...websocket, maxPayloadLength: 8 * 1024, idleTimeout: 60 } as typeof websocket & { maxPayloadLength: number; idleTimeout: number };

export interface WsAuth {
  kind: "agent" | "visitor";
  tenantId: string;
  userId?: string;
  conversationId?: string;
  sessionId?: string;
}

const AUTH_TIMEOUT_MS = 5000;
const MAX_FRAME_CHARS = 4096;

/**
 * Builds the per-socket handlers. `authenticate` validates the token from the FIRST frame (never from the URL).
 */
export function socketHandlers(rt: Realtime, authenticate: (token: string) => Promise<WsAuth | null>): WSEvents {
  let conn: Conn | null = null;
  let authing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let typingHits: number[] = [];
  const send = (ws: WSContext, ev: RealtimeEvent | { type: "pong" }) => ws.send(JSON.stringify(ev));

  return {
    onOpen(_evt, ws) {
      void rt.start();
      timer = setTimeout(() => ws.close(4408, "auth timeout"), AUTH_TIMEOUT_MS);
    },
    async onMessage(evt, ws) {
      if (typeof evt.data !== "string" || evt.data.length > MAX_FRAME_CHARS) return ws.close(1009, "frame too large");
      let frame;
      try {
        const parsed = wsClientFrameSchema.safeParse(JSON.parse(evt.data));
        if (!parsed.success) throw new Error("bad frame");
        frame = parsed.data;
      } catch {
        if (!conn) return ws.close(4401, "unauthorized");
        return send(ws, { type: "error", code: "validation_error", message: "Invalid frame" });
      }

      if (!conn) {
        if (frame.type !== "auth" || authing) return ws.close(4401, "unauthorized");
        authing = true;
        let info: WsAuth | null = null;
        try {
          info = await authenticate(frame.token);
        } catch {
          info = null;
        }
        if (!info) return ws.close(4401, "unauthorized");
        const limit = rt.hub.canAdd(info);
        if (limit) {
          send(ws, { type: "error", code: "rate_limited", message: limit });
          return ws.close(4429, "limit");
        }
        clearTimeout(timer);
        const c: Conn = {
          id: crypto.randomUUID(), ...info,
          send: (ev) => send(ws, ev),
          close: (code, reason) => ws.close(code, reason),
        };
        conn = c;
        rt.hub.add(c);
        send(ws, { type: "ready", kind: c.kind });
        announce(rt, c, true);
        return;
      }

      switch (frame.type) {
        case "auth":
          return;
        case "ping":
          return send(ws, { type: "pong" });
        case "typing": {
          const now = Date.now();
          typingHits = typingHits.filter((t) => t > now - 1000);
          if (typingHits.length >= 5) return;
          typingHits.push(now);
          const conversationId = conn.kind === "visitor" ? conn.conversationId : frame.conversationId;
          if (!conversationId) return;
          void rt.publish({
            t: conn.tenantId, c: conversationId, e: "typing",
            d: { from: conn.kind === "visitor" ? "contact" : "human", userId: conn.userId, typing: frame.typing },
          }).catch(() => {});
          return;
        }
      }
    },
    onClose() {
      clearTimeout(timer);
      if (conn) {
        rt.hub.remove(conn);
        announce(rt, conn, false);
        conn = null;
      }
    },
    onError() {
      clearTimeout(timer);
    },
  };
}

/** Presence: published on the first connection / after the last one for a user (agent) or conversation (visitor). */
export function announce(rt: Realtime, c: Conn, online: boolean): void {
  const same = c.kind === "agent"
    ? rt.hub.countWhere(c.tenantId, (o) => o.kind === "agent" && o.userId === c.userId)
    : rt.hub.countWhere(c.tenantId, (o) => o.kind === "visitor" && o.conversationId === c.conversationId);
  if (online ? same !== 1 : same !== 0) return;
  void rt.publish({
    t: c.tenantId, c: c.kind === "visitor" ? c.conversationId : undefined, e: "presence",
    d: { subject: c.kind === "agent" ? "agent" : "contact", userId: c.userId, online },
  }).catch(() => {});
}
