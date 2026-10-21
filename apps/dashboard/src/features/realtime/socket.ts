import { getAccessToken, refreshSession } from "../../api/client";
import { getApiOrigin } from "../../config";
import type { RealtimeEvent } from "@yulona/shared";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";
type Listener = (e: RealtimeEvent) => void;

export function wsUrl(): string {
  const origin = getApiOrigin() || window.location.origin;
  return `${origin.replace(/^http/, "ws")}/api/v1/realtime/ws`;
}

export function backoff(attempt: number, rnd = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base / 2 + rnd() * (base / 2));
}

/**
 * Reconnecting dashboard socket. The token goes in the first frame, never the URL.
 * Reference counted: start() per consumer, stop() when the last consumer leaves.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: ConnState) => void>();
  private refs = 0;
  private attempt = 0;
  private timer: number | undefined;
  private ping: number | undefined;
  state: ConnState = "closed";

  constructor(private factory: (url: string) => WebSocket = (u) => new WebSocket(u)) {}

  on(l: Listener) { this.listeners.add(l); return () => void this.listeners.delete(l); }
  onState(l: (s: ConnState) => void) { this.stateListeners.add(l); l(this.state); return () => void this.stateListeners.delete(l); }
  private set(s: ConnState) { this.state = s; this.stateListeners.forEach((l) => l(s)); }

  start() { if (this.refs++ === 0) this.connect(); }
  stop() {
    if (--this.refs > 0) return;
    this.refs = 0;
    window.clearTimeout(this.timer);
    window.clearInterval(this.ping);
    this.ws?.close(1000);
    this.ws = null;
    this.set("closed");
  }

  sendTyping(conversationId: string, typing: boolean) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "typing", conversationId, typing }));
  }

  private connect() {
    this.set(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try { ws = this.factory(wsUrl()); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      const token = getAccessToken();
      if (!token) { ws.close(); return; }
      ws.send(JSON.stringify({ type: "auth", token }));
    };
    ws.onmessage = (m) => {
      let e: RealtimeEvent;
      try { e = JSON.parse(String(m.data)) as RealtimeEvent; } catch { return; }
      if (!e || typeof e.type !== "string") return;
      if (e.type === "ready") {
        const reconnected = this.attempt > 0;
        this.attempt = 0;
        this.set("open");
        window.clearInterval(this.ping);
        this.ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
        if (reconnected) this.listeners.forEach((l) => l({ type: "ready", kind: "agent" }));
        return;
      }
      this.listeners.forEach((l) => l(e));
    };
    ws.onclose = async (ev) => {
      window.clearInterval(this.ping);
      if (this.refs === 0 || this.ws !== ws) return;
      // 4401 = token missing/expired: refresh the session before retrying.
      if (ev.code === 4401) await refreshSession();
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (this.refs === 0) return;
    this.set("reconnecting");
    this.timer = window.setTimeout(() => { this.attempt++; this.connect(); }, backoff(this.attempt));
  }
}

export const realtime = new RealtimeClient();
