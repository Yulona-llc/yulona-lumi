import type { PreChatField, Session, UiEvent, WireMessage, WidgetRuntimeConfig } from "./types";

/**
 * Public widget API client for docs/api/conversations.md ("Public widget API").
 * Base: `${apiBase}/public/widget` where apiBase defaults to `<script origin>/api/v1`.
 * Every request carries X-Widget-Key (+ Bearer session token when session-scoped).
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number, public code?: string) {
    super(message);
  }
  /** Network failures, 5xx and 429 are retryable; other 4xx are not. */
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export interface StartResult {
  session: Session;
  messages: WireMessage[];
}

/** Honeypot value (must stay empty) and the Turnstile token, sent with the first request. */
export interface BotFields {
  hp?: string;
  turnstileToken?: string;
}

export interface Api {
  getConfig(): Promise<WidgetRuntimeConfig>;
  startConversation(visitor?: Record<string, string>, visitorId?: string, bot?: BotFields): Promise<StartResult>;
  refresh(s: Session): Promise<Session>;
  history(s: Session, after?: string): Promise<WireMessage[]>;
  send(s: Session, text: string, clientId: string, hp?: string): Promise<WireMessage>;
  uiEvent(s: Session, e: UiEvent, clientId: string): Promise<WireMessage>;
  typing(s: Session, typing: boolean): Promise<void>;
  wsUrl(): string;
  streamUrl(): string;
}

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface PublicMessage {
  id: string;
  senderType: "contact" | "ai" | "human";
  senderName?: string | null;
  content: string;
  ui?: unknown;
  createdAt: string;
}

export function toWire(m: PublicMessage): WireMessage {
  return {
    id: m.id,
    role: m.senderType === "contact" ? "user" : m.senderType,
    text: m.content,
    senderName: m.senderName,
    ui: m.ui ?? undefined,
    createdAt: m.createdAt,
  };
}

const PRECHAT_KIND: Record<string, PreChatField["kind"]> = { name: "text", email: "email", phone: "phone" };

/** Accepts an `/api/v1` base or a bare origin from the embed snippet's `apiUrl`. */
export function resolveApiBase(explicit: string | undefined, origin: string): string {
  const raw = (explicit ?? "").trim().replace(/\/+$/, "");
  if (!raw) return `${origin.replace(/\/+$/, "")}/api/v1`;
  return /\/api\/v1$/.test(raw) ? raw : `${raw}/api/v1`;
}

export function createApi(base: string, widgetKey: string, f: Fetch = (...a) => fetch(...a)): Api {
  const root = base.replace(/\/$/, "") + "/public/widget";

  async function call<T>(path: string, init: RequestInit & { session?: Session } = {}): Promise<T> {
    const headers: Record<string, string> = { "x-widget-key": widgetKey };
    if (init.body) headers["content-type"] = "application/json";
    if (init.session) headers.authorization = `Bearer ${init.session.sessionToken}`;
    let res: Response;
    try {
      res = await f(root + path, { ...init, headers, credentials: "omit" });
    } catch {
      throw new ApiError(0, "network");
    }
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        /* no JSON body */
      }
      throw new ApiError(res.status, `HTTP ${res.status}`, Number(res.headers.get("retry-after")) || undefined, code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const sessionFrom = (r: { sessionToken: string; expiresIn?: number; visitorId?: string; conversation?: { id: string } }, prev?: Session): Session => ({
    conversationId: r.conversation?.id ?? prev!.conversationId,
    sessionToken: r.sessionToken,
    visitorId: r.visitorId ?? prev?.visitorId,
    expiresAt: r.expiresIn ? Date.now() + r.expiresIn * 1000 : prev?.expiresAt,
  });

  return {
    async getConfig() {
      const r = await call<{
        name?: string;
        config?: Record<string, unknown>;
        prechat?: { enabled?: boolean; intro?: string; fields?: { name: PreChatField["name"]; label: string; required?: boolean }[] };
        schemaVersion?: number;
        unavailable?: boolean;
      }>("/config");
      const c = (r.config ?? {}) as Record<string, string | undefined>;
      const prot = ((r.config ?? {}).protection ?? {}) as {
        honeypot?: boolean;
        turnstile?: { enabled?: boolean; siteKey?: string; theme?: string; size?: string; appearance?: string; action?: string };
      };
      const ts = prot.turnstile;
      const ap = (r.config ?? {}).appearance as { mode?: string; color?: string; color2?: string; angle?: number } | undefined;
      const hexOk = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
      const appearance = ap && hexOk(ap.color)
        ? { mode: ap.mode === "gradient" && hexOk(ap.color2) ? "gradient" as const : "solid" as const, color: ap.color, color2: hexOk(ap.color2) ? ap.color2 : undefined, angle: typeof ap.angle === "number" && Number.isFinite(ap.angle) ? ap.angle : 135 }
        : undefined;
      return {
        title: c.title ?? r.name ?? "Chat",
        subtitle: c.subtitle,
        primaryColor: appearance?.color ?? c.primaryColor ?? "#4f46e5",
        appearance,
        logoUrl: c.avatarUrl,
        position: c.position === "left" ? "left" : "right",
        theme: c.theme === "dark" || c.theme === "auto" ? c.theme : "light",
        placeholder: c.inputPlaceholder,
        launcherLabel: c.launcherLabel,
        schemaVersion: r.schemaVersion,
        unavailable: r.unavailable === true,
        protection: {
          honeypot: prot.honeypot !== false,
          turnstile: ts?.enabled && ts.siteKey
            ? {
                siteKey: ts.siteKey,
                theme: ts.theme === "light" || ts.theme === "dark" ? ts.theme : "auto",
                size: ts.size === "compact" || ts.size === "flexible" ? ts.size : "normal",
                appearance: ts.appearance === "interaction-only" ? "interaction-only" : "always",
                action: ts.action || undefined,
              }
            : undefined,
        },
        preChat: r.prechat?.enabled
          ? {
              enabled: true,
              intro: r.prechat.intro,
              fields: (r.prechat.fields ?? []).map((x) => ({ name: x.name, label: x.label, required: x.required, kind: PRECHAT_KIND[x.name] ?? "text" })),
            }
          : undefined,
      };
    },
    async startConversation(visitor, visitorId, bot) {
      let timezone: string | undefined;
      try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        /* ignore */
      }
      const clean = visitor && Object.fromEntries(Object.entries(visitor).filter(([, v]) => v));
      const r = await call<{ sessionToken: string; expiresIn: number; visitorId: string; conversation: { id: string }; messages?: PublicMessage[] }>(
        "/conversations",
        {
          method: "POST",
          body: JSON.stringify({
            visitorId,
            hp: bot?.hp || undefined,
            turnstileToken: bot?.turnstileToken || undefined,
            visitor: clean && Object.keys(clean).length ? clean : undefined,
            context: { pageUrl: location.href.slice(0, 500), referrer: document.referrer.slice(0, 500) || undefined, locale: navigator.language, timezone },
          }),
        },
      );
      return { session: sessionFrom(r), messages: (r.messages ?? []).map(toWire) };
    },
    async refresh(s) {
      const r = await call<{ sessionToken: string; expiresIn?: number }>("/session/refresh", { method: "POST", session: s });
      return sessionFrom(r, s);
    },
    async history(s, after) {
      const r = await call<{ items: PublicMessage[] }>(`/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`, { session: s });
      return r.items.map(toWire);
    },
    async send(s, text, clientId, hp) {
      return toWire(await call<PublicMessage>("/messages", { method: "POST", session: s, body: JSON.stringify({ text, clientMessageId: clientId, hp: hp || undefined }) }));
    },
    async uiEvent(s, e, clientId) {
      const p = e.payload;
      const common = { messageId: e.messageId, componentId: e.componentId.slice(-64), clientMessageId: clientId };
      const body =
        e.kind === "form"
          ? { type: "form_submit", ...common, values: p }
          : e.kind === "calendar"
            ? { type: "calendar_select", ...common, start: p.start, end: p.end, timezone: p.timezone }
            : { type: "button_click", ...common, value: p.value, label: p.label };
      return toWire(await call<PublicMessage>("/ui-events", { method: "POST", session: s, body: JSON.stringify(body) }));
    },
    async typing(s, typing) {
      await call("/typing", { method: "POST", session: s, body: JSON.stringify({ typing }) });
    },
    wsUrl: () => `${root.replace(/^http/, "ws")}/ws?key=${encodeURIComponent(widgetKey)}`,
    streamUrl: () => `${root}/stream`,
  };
}
