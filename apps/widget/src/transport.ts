import type { Api } from "./api";
import { toWire } from "./api";
import type { ServerEvent, Session } from "./types";

export interface Transport {
  stop(): void;
}
export interface TransportHandlers {
  onEvent(e: ServerEvent): void;
  /** Called on (re)connect and on every poll tick so the caller can catch up via GET /messages?after=. */
  onSync(): void;
  onStatus(s: "live" | "polling" | "offline"): void;
  onAuthError(): void;
}

const POLL_MS = 4000;
const PING_MS = 25000;

/** Maps a server frame (WS JSON, or SSE data + event name) to a normalised event. */
export function parseFrame(raw: string, evName?: string): ServerEvent | "ready" | "unauthorized" | "pong" | undefined {
  let m: { type?: string; message?: never; typing?: boolean; from?: string; code?: string };
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!m || typeof m !== "object") return undefined;
  const type = m.type ?? evName;
  switch (type) {
    case "ready":
      return "ready";
    case "pong":
      return "pong";
    case "message.created":
      return m.message ? { type: "message", message: toWire(m.message) } : undefined;
    case "typing":
      return { type: "typing", on: m.typing === true, from: m.from };
    case "error":
      return m.code === "unauthorized" || m.code === "forbidden" ? "unauthorized" : undefined;
    default:
      return undefined; // conversation.updated / presence: not needed by the visitor UI
  }
}

/**
 * WebSocket first (token sent as first frame, never in the URL) -> SSE via fetch streaming
 * (EventSource can't set headers) -> polling. Polling runs whenever no live channel is up.
 */
export function startTransport(api: Api, s: Session, widgetKey: string, h: TransportHandlers): Transport {
  let stopped = false;
  let ws: WebSocket | undefined;
  let abort: AbortController | undefined;
  let retryT: ReturnType<typeof setTimeout> | undefined;
  let pollT: ReturnType<typeof setInterval> | undefined;
  let pingT: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;

  const backoff = () => Math.min(30000, 1000 * 2 ** attempts++);
  const retryLater = (fn: () => void) => {
    clearTimeout(retryT);
    retryT = setTimeout(() => !stopped && fn(), backoff());
  };

  function startPolling() {
    if (pollT) return;
    h.onStatus(navigator.onLine === false ? "offline" : "polling");
    h.onSync();
    pollT = setInterval(() => h.onSync(), POLL_MS);
  }
  function stopPolling() {
    clearInterval(pollT);
    pollT = undefined;
  }
  function live() {
    attempts = 0;
    stopPolling();
    h.onStatus("live");
    h.onSync();
  }
  function dispatch(r: ReturnType<typeof parseFrame>): boolean {
    if (r === "ready") live();
    else if (r === "unauthorized") h.onAuthError();
    else if (r && r !== "pong") h.onEvent(r);
    return r === "ready";
  }

  async function sse() {
    if (stopped) return;
    abort = new AbortController();
    try {
      const res = await fetch(api.streamUrl(), {
        headers: { authorization: `Bearer ${s.sessionToken}`, "x-widget-key": widgetKey, accept: "text/event-stream" },
        signal: abort.signal,
        credentials: "omit",
      });
      if (res.status === 401) return h.onAuthError();
      if (!res.ok || !res.body) throw new Error("sse unavailable");
      live();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev: string | undefined;
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length) dispatch(parseFrame(data.join("\n"), ev));
        }
      }
    } catch {
      /* fall through to polling + retry */
    }
    if (stopped) return;
    startPolling();
    retryLater(() => void sse());
  }

  function connectWs() {
    if (stopped) return;
    if (typeof WebSocket === "undefined") return void sse();
    let ready = false;
    try {
      ws = new WebSocket(api.wsUrl());
    } catch {
      return void sse();
    }
    const sock = ws;
    sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: s.sessionToken }));
    sock.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (dispatch(parseFrame(ev.data))) {
        ready = true;
        clearInterval(pingT);
        pingT = setInterval(() => sock.readyState === 1 && sock.send(JSON.stringify({ type: "ping" })), PING_MS);
      }
    };
    sock.onclose = () => {
      clearInterval(pingT);
      if (stopped) return;
      if (!ready) return void sse(); // blocked/unsupported (proxy, corporate network): fall back
      startPolling(); // catch up while we reconnect
      retryLater(connectWs);
    };
    sock.onerror = () => sock.close();
  }

  connectWs();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryT);
      stopPolling();
      clearInterval(pingT);
      abort?.abort();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}
