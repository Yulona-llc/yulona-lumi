import { z } from "zod";
import { request as rawRequest, getAccessToken, ApiError, type Opts } from "../../api/client";
import { apiBase } from "../../config";

/** Typed client for `docs/api/ops.md`. Shared by tickets / transactions / bookings / attention / ops-settings. */
/** Typed-by-assertion wrapper: the client only parses JSON when given a schema. */
const request = <T,>(path: string, o: Opts<T> = {}) => rawRequest<T>(path, { ...o, schema: z.any() as z.ZodType<T> });
const A = { auth: true } as const;
const j = (method: string, body?: unknown) => ({ method, auth: true as const, body });

export type Page<T> = { items: T[]; nextCursor: string | null };
export const qs = (p: Record<string, string | number | boolean | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const TICKET_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export interface Tag { id: string; name: string; color: string; count?: number }
export interface Ticket {
  id: string; number: number; title: string; description: string | null; status: TicketStatus; priority: TicketPriority;
  assigneeUserId: string | null; assigneeName: string | null; contactId: string | null; contactName: string | null; conversationId: string | null;
  dueAt: string | null; slaBreachedAt: string | null; resolvedAt: string | null; createdBy: string | null; tags: Tag[]; createdAt: string; updatedAt: string;
}
export interface TicketEvent { id: string; ticketId: string; actorUserId: string | null; actorName: string | null; type: string; data: Record<string, unknown> | null; createdAt: string }
export interface TicketFilters { q?: string; priority?: string; assignee?: string; slaBreached?: boolean; status?: string }
export interface Board { columns: Record<TicketStatus, Ticket[]>; totals: Record<TicketStatus, number> }

export const TXN_STATUSES = ["pending", "completed", "failed", "refunded"] as const;
export type TxnStatus = (typeof TXN_STATUSES)[number];
export interface Transaction {
  id: string; externalId: string | null; source: "manual" | "webhook"; amountCents: number; currency: string; status: TxnStatus; description: string | null;
  contactId: string | null; contactName: string | null; conversationId: string | null; metadata: Record<string, unknown>; occurredAt: string; createdAt: string; updatedAt: string;
}
export interface TxnFilters { status?: string; q?: string; from?: string; to?: string; currency?: string; source?: string }
export interface TxnPage extends Page<Transaction> { summary: { count: number; totalCents: number | null; byCurrency?: Array<{ currency: string; count: number; totalCents: number }> | Record<string, number> } }
export interface WebhookEndpoint { id: string; name: string; url: string; enabled?: boolean; secret?: string; createdAt?: string }

export interface Booking {
  id: string; status: "booked" | "cancelled" | "failed" | "offered"; title: string; startAt: string; endAt: string; timezone: string | null; contactId: string | null; contactName: string | null;
  conversationId: string | null; attendeeEmail: string | null; notes: string | null; provider: "google" | "calendly" | null; externalEventId: string | null; eventUrl: string | null;
  failureReason: string | null; cancelledAt: string | null; createdAt: string;
}
export interface CalendarConnection { connected: boolean; provider?: "google"; accountEmail?: string; calendarId?: string; status?: "active" | "error"; connectedAt?: string }

export type CalendarProviderKey = "google" | "calendly";
export interface CalendarProviderState {
  provider: CalendarProviderKey; configured: boolean; connected: boolean; accountEmail?: string | null; calendarId?: string; eventTypeSelected?: boolean;
  status?: "active" | "error"; lastError?: string | null; isDefault?: boolean; connectedAt?: string | null;
}
export interface CalendlyEventTypeOption { uri: string; name: string; durationMinutes: number; schedulingUrl: string | null; selected: boolean }

export type HandoffType = "uncertainty" | "stage" | "system_failure";
export interface HandoffItem {
  id: string; type: HandoffType; reason: string; summary: string | null; leadCard: Record<string, unknown> | null; outOfHours: boolean; state: "open" | "claimed" | "resolved";
  assignedUserId: string | null; assignedUserName: string | null; claimedAt: string | null; resolvedAt: string | null; resolutionNote: string | null; createdAt: string;
  conversation: { id: string; status: string; handler: string; channel: string; assignedUserId: string | null; lastMessagePreview: string | null; lastMessageAt: string };
  contact: { id: string; name: string | null; email: string | null; phone: string | null };
}
export interface HandoffCounts { uncertainty: number; stage: number; system_failure: number; total: number; mine: number }

export type Availability = "online" | "away" | "offline";
export interface TeamAvailability { userId: string; name: string; role: string; status: Availability; updatedAt: string | null; openConversations: number }
export interface OpsSettings {
  timezone: string; slaMinutes: { urgent: number; high: number; normal: number; low: number };
  outOfHours: { mode: "ai_only" | "message" | "queue"; message: string | null }; assignment: { mode: "manual" | "least_busy" };
  holidays: string[]; businessHours: Array<{ weekday: number; start: string; end: string }>;
}
export interface Canned { id: string; shortcut: string; title: string; content: string; createdBy: string | null; createdAt: string; updatedAt: string }
export interface Notif { id: string; type: string; title: string; body: string | null; data: Record<string, string | undefined>; readAt: string | null; createdAt: string }

export const ops = {
  // tickets
  tickets: (f: TicketFilters, cursor?: string) => request<Page<Ticket>>(`/tickets${qs({ ...f, limit: 50, cursor })}`, A),
  board: (f: TicketFilters) => request<Board>(`/tickets/board${qs({ ...f, status: undefined })}`, A),
  ticket: (id: string) => request<Ticket>(`/tickets/${id}`, A),
  createTicket: (b: { title: string; description?: string; priority?: TicketPriority; assigneeUserId?: string }) => request<Ticket>("/tickets", j("POST", b)),
  patchTicket: (id: string, b: Record<string, unknown>) => request<Ticket>(`/tickets/${id}`, j("PATCH", b)),
  deleteTicket: (id: string) => request<void>(`/tickets/${id}`, j("DELETE")),
  ticketEvents: (id: string) => request<Page<TicketEvent>>(`/tickets/${id}/events?limit=100`, A),
  comment: (id: string, text: string) => request<TicketEvent>(`/tickets/${id}/comments`, j("POST", { text })),
  bulk: (b: { ids: string[]; action: "set_status" | "set_priority" | "assign" | "delete"; value?: string | null }) => request<{ updated: number; skipped: number }>("/tickets/bulk", j("POST", b)),

  // transactions
  txns: (f: TxnFilters, cursor?: string) => request<TxnPage>(`/transactions${qs({ ...f, limit: 50, cursor })}`, A),
  createTxn: (b: { amountCents: number; currency: string; status?: TxnStatus; description?: string; externalId?: string; occurredAt?: string }) => request<Transaction>("/transactions", j("POST", b)),
  patchTxn: (id: string, b: Record<string, unknown>) => request<Transaction>(`/transactions/${id}`, j("PATCH", b)),
  deleteTxn: (id: string) => request<void>(`/transactions/${id}`, j("DELETE")),
  endpoints: () => request<{ items: WebhookEndpoint[] }>("/transactions/webhook-endpoints", A).then((r) => r.items),
  createEndpoint: (name: string) => request<WebhookEndpoint>("/transactions/webhook-endpoints", j("POST", { name })),
  rotateEndpoint: (id: string) => request<{ secret: string }>(`/transactions/webhook-endpoints/${id}/rotate-secret`, j("POST", {})),
  patchEndpoint: (id: string, b: { name?: string; enabled?: boolean }) => request<WebhookEndpoint>(`/transactions/webhook-endpoints/${id}`, j("PATCH", b)),
  deleteEndpoint: (id: string) => request<void>(`/transactions/webhook-endpoints/${id}`, j("DELETE")),

  // bookings + calendar
  bookings: (f: { status?: string; from?: string; to?: string }, cursor?: string) => request<Page<Booking>>(`/bookings${qs({ ...f, limit: 100, cursor })}`, A),
  createBooking: (b: { startAt: string; durationMinutes?: number; title?: string; attendeeEmail?: string; notes?: string }) => request<Booking>("/bookings", j("POST", b)),
  cancelBooking: (id: string, reason?: string) => request<Booking>(`/bookings/${id}/cancel`, j("POST", reason ? { reason } : {})),
  calendar: () => request<CalendarConnection>("/calendar/connection", A),
  connectCalendar: () => request<{ url: string }>("/calendar/google/connect", j("POST", {})),
  patchCalendar: (calendarId: string) => request<CalendarConnection>("/calendar/connection", j("PATCH", { calendarId })),
  disconnectCalendar: () => request<void>("/calendar/connection", j("DELETE")),
  calendars: () => request<{ items: CalendarProviderState[]; default: CalendarProviderKey | null }>("/calendar/connections", A),
  setDefaultCalendar: (provider: CalendarProviderKey) => request<{ default: CalendarProviderKey }>("/calendar/default", j("POST", { provider })),
  connectCalendly: () => request<{ url: string }>("/calendar/calendly/connect", j("POST", {})),
  calendlyEventTypes: () => request<{ items: CalendlyEventTypeOption[] }>("/calendar/calendly/event-types", A).then((r) => r.items),
  setCalendlyEventType: (eventTypeUri: string) => request<{ eventTypeUri: string; name: string; durationMinutes: number }>("/calendar/calendly/event-type", j("PATCH", { eventTypeUri })),
  disconnectCalendly: () => request<void>("/calendar/calendly/connection", j("DELETE")),

  // needs attention
  attention: (f: { state?: string; type?: string; assignee?: string }, cursor?: string) => request<Page<HandoffItem>>(`/needs-attention${qs({ ...f, limit: 50, cursor })}`, A),
  counts: () => request<HandoffCounts>("/needs-attention/counts", A),
  claim: (id: string, force?: boolean) => request<HandoffItem>(`/needs-attention/${id}/claim`, j("POST", force ? { force: true } : {})),
  assign: (id: string, userId: string) => request<HandoffItem>(`/needs-attention/${id}/assign`, j("POST", { userId })),
  release: (id: string) => request<HandoffItem>(`/needs-attention/${id}/release`, j("POST", {})),
  resolve: (id: string, b: { note?: string; returnToAi?: boolean }) => request<HandoffItem>(`/needs-attention/${id}/resolve`, j("POST", b)),

  // availability + settings
  team: () => request<{ items: TeamAvailability[] }>("/availability", A).then((r) => r.items),
  setMyStatus: (status: Availability) => request<TeamAvailability>("/availability/me", j("PUT", { status })),
  settings: () => request<OpsSettings>("/ops/settings", A),
  saveSettings: (b: Partial<OpsSettings>) => request<OpsSettings>("/ops/settings", j("PUT", b)),
  hoursStatus: () => request<{ open: boolean; timezone: string; now: string }>("/business-hours/status", A),

  // canned + tags
  canned: () => request<Page<Canned>>("/canned-responses?limit=100", A).then((r) => r.items),
  createCanned: (b: { shortcut: string; title: string; content: string }) => request<Canned>("/canned-responses", j("POST", b)),
  patchCanned: (id: string, b: Partial<{ shortcut: string; title: string; content: string }>) => request<Canned>(`/canned-responses/${id}`, j("PATCH", b)),
  deleteCanned: (id: string) => request<void>(`/canned-responses/${id}`, j("DELETE")),
  tags: () => request<{ items: Tag[] }>("/tags", A).then((r) => r.items),
  createTag: (b: { name: string; color?: string }) => request<Tag>("/tags", j("POST", b)),
  patchTag: (id: string, b: { name?: string; color?: string }) => request<Tag>(`/tags/${id}`, j("PATCH", b)),
  deleteTag: (id: string) => request<void>(`/tags/${id}`, j("DELETE")),
  setTicketTags: (id: string, tagIds: string[]) => request<{ items: Tag[] }>(`/tickets/${id}/tags`, j("PUT", { tagIds })),

  // notifications
  notifications: (unread?: boolean) => request<Page<Notif> & { unreadCount: number }>(`/notifications${qs({ unread, limit: 20 })}`, A),
  markRead: (id: string) => request<void>(`/notifications/${id}/read`, j("POST", {})),
  readAll: () => request<{ updated: number }>("/notifications/read-all", j("POST", {})),
  prefs: () => request<{ email: boolean }>("/notifications/preferences", A),
  setPrefs: (email: boolean) => request<{ email: boolean }>("/notifications/preferences", j("PUT", { email })),
};

/** Authenticated CSV download (fetch -> blob -> anchor). Stays on the configured API origin. */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${getAccessToken() ?? ""}` }, credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "export_failed", `Export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export const money = (cents: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
};
export const label = (s: string) => s.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso).getTime() - now;
  const abs = Math.abs(d), m = Math.round(abs / 60000), h = Math.round(abs / 3600000), dd = Math.round(abs / 86400000);
  const t = m < 60 ? `${Math.max(m, 1)}m` : h < 48 ? `${h}h` : `${dd}d`;
  return d < 0 ? `${t} ago` : `in ${t}`;
}
