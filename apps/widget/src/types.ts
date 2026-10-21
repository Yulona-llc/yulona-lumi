import type { WidgetUISchema } from "@yulona/shared";

export type { WidgetUISchema };

export interface YulonaConfig {
  widgetKey: string;
  /** e.g. https://app.example.com/api/v1 (no trailing slash). Defaults to the origin the script was loaded from + /api/v1. */
  apiBase?: string;
  /** Embed-snippet alias for the API origin (`http://localhost:3000`) or an `/api/v1` base. */
  apiUrl?: string;
  /** Local fallbacks; runtime config from the server wins. */
  primaryColor?: string;
  position?: "right" | "left";
  /** Start opened. */
  open?: boolean;
}

export interface PreChatField {
  name: "name" | "email" | "phone";
  label: string;
  kind: "text" | "email" | "phone";
  required?: boolean;
}

/** Normalised view of GET /public/widget/config (config + prechat). */
export interface WidgetRuntimeConfig {
  title: string;
  subtitle?: string;
  primaryColor: string;
  logoUrl?: string;
  position: "right" | "left";
  theme: "light" | "dark" | "auto";
  placeholder?: string;
  launcherLabel?: string;
  preChat?: { enabled: boolean; intro?: string; fields: PreChatField[] };
  /** Highest WidgetUISchema version the server may emit. */
  schemaVersion?: number;
}

export type Role = "user" | "ai" | "human" | "system";

export interface WireMessage {
  id: string;
  role: Role;
  /** Plain text fallback (always present for user messages). */
  text?: string;
  senderName?: string | null;
  /** Declarative UI. Treated as untrusted/unknown shape; see render/normalize.ts. */
  ui?: unknown;
  createdAt: string;
}

export interface ChatMessage extends WireMessage {
  /** Local-only delivery state for user messages. */
  state?: "sending" | "failed" | "sent";
  clientId?: string;
}

export interface Session {
  conversationId: string;
  sessionToken: string;
  /** epoch ms; used to refresh the token before it lapses */
  expiresAt?: number;
  visitorId?: string;
}

export type UiEventKind = "form" | "calendar" | "button";
export interface UiEvent {
  messageId: string;
  componentId: string;
  kind: UiEventKind;
  payload: Record<string, unknown>;
}

/** Normalised realtime events (transport maps wire frames to these). */
export type ServerEvent =
  | { type: "message"; message: WireMessage }
  | { type: "typing"; on: boolean; from?: string };
