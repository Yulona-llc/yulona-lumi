import { z } from "zod";
import {
  contactSchema,
  conversationSummarySchema,
  messageDtoSchema,
  pageSchema,
  type ContactDto,
  type ConversationSummary,
  type MessageDto,
} from "@yulona/shared";
import { ApiError, request } from "../../api/client";

export type { ContactDto, ConversationSummary, MessageDto };

export const convPage = pageSchema(conversationSummarySchema);
export const msgPage = pageSchema(messageDtoSchema);
export type ConvPage = z.infer<typeof convPage>;
export type MsgPage = z.infer<typeof msgPage>;

/** Message as held in the client cache, possibly not yet confirmed by the server. */
export type MessageView = MessageDto & { pending?: boolean; failed?: boolean };

export interface ConvFilters {
  status?: string;
  handler?: string;
  channel?: string;
  assignee?: string;
  q?: string;
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export const inboxApi = {
  list: (f: ConvFilters, cursor?: string) =>
    request(`/conversations${qs({ ...f, limit: 30, cursor })}`, { auth: true, schema: convPage }),
  get: (id: string) => request(`/conversations/${id}`, { auth: true, schema: conversationSummarySchema }),
  messages: (id: string, before?: string) =>
    request(`/conversations/${id}/messages${qs({ before, limit: 50 })}`, { auth: true, schema: msgPage }),
  send: (id: string, text: string, kind: "reply" | "note") =>
    request(`/conversations/${id}/messages`, { method: "POST", auth: true, body: { text, kind }, schema: messageDtoSchema }),
  takeover: (id: string) => request(`/conversations/${id}/takeover`, { method: "POST", auth: true }),
  returnToAi: (id: string) => request(`/conversations/${id}/return-to-ai`, { method: "POST", auth: true }),
  patch: (id: string, body: { status?: "open" | "resolved"; assignedUserId?: string | null }) =>
    request(`/conversations/${id}`, { method: "PATCH", auth: true, body }),
  users: () =>
    request("/users", {
      auth: true,
      schema: z.object({ items: z.array(z.object({ id: z.uuid(), name: z.string(), email: z.string(), role: z.string(), status: z.string() })) }),
    }),
  /** Built by ops-backend (see docs/api/dashboard-needs.md); returns [] while the endpoint is missing. */
  canned: async (): Promise<CannedResponse[]> => {
    try {
      const r = await request("/canned-responses?limit=100", {
        auth: true,
        schema: z.object({ items: z.array(z.object({ id: z.string(), title: z.string(), content: z.string(), shortcut: z.string().nullable().optional() })) }),
      });
      return r.items.map((c) => ({ id: c.id, title: c.title, body: c.content, shortcut: c.shortcut }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 405)) return [];
      throw e;
    }
  },
};

export interface CannedResponse {
  id: string;
  title: string;
  body: string;
  shortcut?: string | null;
}

/** Fallback so the composer is useful before the backend lands. Clearly generic wording. */
export const FALLBACK_CANNED: CannedResponse[] = [
  { id: "f1", title: "Greeting", body: "Hi! Thanks for reaching out. How can I help you today?", shortcut: "hi" },
  { id: "f2", title: "One moment", body: "Thanks for your patience. I am looking into this now and will be right back.", shortcut: "wait" },
  { id: "f3", title: "Anything else?", body: "Is there anything else I can help you with?", shortcut: "else" },
];

// ---------- unread tracking (client-side; no server read-state yet) ----------
const KEY = "yl_inbox_read_v1";
interface ReadState { baseline: string; read: Record<string, string> }
function load(): ReadState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as ReadState | null;
    if (s?.baseline) return s;
  } catch { /* ignore */ }
  return { baseline: new Date().toISOString(), read: {} };
}
function save(s: ReadState) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage may be blocked */ }
}
export function markRead(id: string) {
  const s = load();
  s.read[id] = new Date().toISOString();
  const keys = Object.keys(s.read);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete s.read[k];
  save(s);
}
export function isUnread(c: ConversationSummary, activeId?: string): boolean {
  if (c.id === activeId || !c.lastCustomerMessageAt) return false;
  const s = load();
  save(s);
  const since = s.read[c.id] ?? s.baseline;
  return c.lastCustomerMessageAt > since;
}

// ---------- AI state (stage + lead card) ----------
export interface AiState {
  stage: string | null;
  lead: Record<string, unknown>;
  handoff?: { type: string; reason?: string } | null;
  derived: boolean;
}
const aiStateSchema = z.object({
  stage: z.string().nullable().optional(),
  lead: z.record(z.string(), z.unknown()).optional(),
  handoff: z.object({ type: z.string(), reason: z.string().optional() }).nullable().optional(),
});
/**
 * `GET /conversations/:id/ai-state` (stage, lead card, active handoff) is the source of truth. Only if an older API
 * answers 404/405/501 do we fall back to the newest AI message metadata (stage/handoff only, no lead card).
 */
export async function loadAiState(id: string, messages: MessageView[]): Promise<AiState> {
  try {
    const r = await request(`/conversations/${id}/ai-state`, { auth: true, schema: aiStateSchema });
    return { stage: r.stage ?? null, lead: r.lead ?? {}, handoff: r.handoff ?? null, derived: false };
  } catch (e) {
    if (!(e instanceof ApiError) || ![404, 405, 501].includes(e.status)) throw e;
  }
  const ai = [...messages].reverse().find((m) => m.senderType === "ai" && m.metadata && "stage" in m.metadata);
  const md = (ai?.metadata ?? {}) as { stage?: string; handoff?: { type: string; reason?: string } };
  return { stage: md.stage ?? null, lead: {}, handoff: md.handoff ?? null, derived: true };
}
