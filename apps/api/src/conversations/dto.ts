import type { ContactDto, ConversationSummary, MessageDto, PublicMessage } from "@yulona/shared";

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoReq = (d: Date | string): string => iso(d)!;

export interface MessageRow {
  id: string;
  conversationId: string;
  senderType: MessageDto["senderType"];
  senderUserId: string | null;
  senderName?: string | null;
  content: string;
  ui: unknown;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
}
export function toMessageDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    conversationId: r.conversationId,
    senderType: r.senderType,
    senderUserId: r.senderUserId,
    senderName: r.senderName ?? null,
    content: r.content,
    ui: (r.ui as MessageDto["ui"]) ?? null,
    metadata: r.metadata ?? {},
    createdAt: isoReq(r.createdAt),
  };
}
/** Visitor view. Callers must have filtered out `note` / `system` rows. */
export function toPublicMessage(r: MessageRow): PublicMessage {
  return {
    id: r.id,
    senderType: r.senderType as PublicMessage["senderType"],
    senderName: r.senderType === "human" ? (r.senderName ?? null) : null,
    content: r.content,
    ui: r.ui ?? null,
    createdAt: isoReq(r.createdAt),
  };
}
export const isVisitorVisible = (senderType: string) => senderType === "contact" || senderType === "ai" || senderType === "human";

export interface ConversationRow {
  id: string;
  channel: ConversationSummary["channel"];
  status: ConversationSummary["status"];
  handler: ConversationSummary["handler"];
  assignedUserId: string | null;
  agentId: string | null;
  widgetId: string | null;
  lastMessageAt: Date | string;
  lastMessagePreview: string | null;
  lastCustomerMessageAt: Date | string | null;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactBlockedAt?: Date | string | null;
  cursorTs?: string;
}
export function toConversationSummary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    channel: r.channel,
    status: r.status,
    handler: r.handler,
    assignedUserId: r.assignedUserId,
    agentId: r.agentId,
    widgetId: r.widgetId,
    contact: { id: r.contactId, name: r.contactName, email: r.contactEmail, phone: r.contactPhone, blockedAt: iso(r.contactBlockedAt) },
    lastMessageAt: isoReq(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview,
    lastCustomerMessageAt: iso(r.lastCustomerMessageAt),
    createdAt: isoReq(r.createdAt),
    resolvedAt: iso(r.resolvedAt),
  };
}

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  customAttributes: Record<string, unknown>;
  identities: { channel: ContactDto["identities"][number]["channel"]; externalId: string }[];
  blockedAt?: Date | string | null;
  blockedReason?: string | null;
  blockedBy?: string | null;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
}
export function toContactDto(r: ContactRow): ContactDto {
  return {
    id: r.id, name: r.name, email: r.email, phone: r.phone,
    customAttributes: r.customAttributes ?? {},
    identities: r.identities ?? [],
    blockedAt: iso(r.blockedAt), blockedReason: r.blockedReason ?? null, blockedBy: r.blockedBy ?? null,
    firstSeenAt: isoReq(r.firstSeenAt), lastSeenAt: isoReq(r.lastSeenAt),
    createdAt: isoReq(r.createdAt), updatedAt: isoReq(r.updatedAt),
  };
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`).toString("base64url");
}
export function decodeCursor(c: string | undefined): { ts: string; id: string } | null {
  if (!c) return null;
  try {
    const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
    if (!ts || !id || Number.isNaN(Date.parse(ts))) return null;
    return { ts, id };
  } catch {
    return null;
  }
}
