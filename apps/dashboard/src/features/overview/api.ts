import type { ConversationSummary } from "@yulona/shared";
import { req, qs } from "../integrations-ui/http";

export interface UsagePoint { day: string; metric: string; value: number }
export interface HandoffLite {
  id: string; type: string; reason: string; summary: string | null; state: string; createdAt: string;
  conversation: { id: string; channel: string; lastMessagePreview: string | null };
  contact: { id: string; name: string | null; email: string | null; phone: string | null };
}
export interface BookingLite { id: string; status: string; conversationId: string | null; startAt: string }

const items = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { items?: T[] })?.items ?? [])) as T[];

export const overviewApi = {
  usage: (days: number) => req<{ series: UsagePoint[] }>(`/usage${qs({ days })}`).then((r) => r.series),
  conversations: (p: { status?: string; limit?: number }) => req<unknown>(`/conversations${qs(p)}`).then((r) => items<ConversationSummary>(r)),
  attention: () => req<unknown>(`/needs-attention${qs({ state: "open", limit: 50 })}`).then((r) => items<HandoffLite>(r)),
  bookings: () => req<unknown>(`/bookings${qs({ status: "booked", limit: 100 })}`).then((r) => items<BookingLite>(r)),
  agents: () => req<unknown>("/agents").then((r) => items<{ id: string; status: string }>(r)),
  sources: () => req<unknown>(`/knowledge/sources${qs({ limit: 100 })}`).then((r) => items<{ id: string; status: string }>(r)),
  channels: () => req<unknown>("/channels/connections").then((r) => items<{ id: string }>(r)),
  widgets: () => req<unknown>("/widgets").then((r) => items<{ id: string }>(r)),
};

/** Four-step funnel from the latest conversations (no tenant funnel endpoint exists yet). */
export interface FunnelStep { key: string; label: string; count: number }
export function buildFunnel(convs: ConversationSummary[], bookings: BookingLite[], sinceMs: number): FunnelStep[] {
  const sample = convs.filter((c) => new Date(c.createdAt).getTime() >= sinceMs);
  const ids = new Set(sample.map((c) => c.id));
  const engaged = sample.filter((c) => c.lastCustomerMessageAt);
  const qualified = engaged.filter((c) => c.contact.email || c.contact.phone);
  const booked = new Set(bookings.filter((b) => b.conversationId && ids.has(b.conversationId)).map((b) => b.conversationId));
  return [
    { key: "visitor", label: "Started", count: sample.length },
    { key: "engaged", label: "Engaged", count: engaged.length },
    { key: "qualified", label: "Qualified", count: Math.max(qualified.length, booked.size) },
    { key: "booked", label: "Booked", count: booked.size },
  ];
}

export function waitLabel(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return "none";
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}
