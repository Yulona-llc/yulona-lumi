import { Hono } from "hono";
import { z } from "zod";
import { AuditLogRepository, withTenant, type Tx } from "@yulona/db";
import { bookSlot, cancelBooking, CalendlyClient, GoogleCalendarClient, loadTenantCalendarAny } from "@yulona/ops";
import { cancelBookingSchema, conversationHandlerSchema, conversationStatusSchema, createBookingSchema, createContactSchema, listContactsQuerySchema, updateContactSchema } from "@yulona/shared";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { requireApiKey, requireScope, type ApiKeyEnv } from "../routes/api-keys";
import { assertWithinLimit } from "../platform/limits";
import { isFkViolation, parseId } from "../platform/util";
import { opsRuntimeFromEnv } from "../ops/common";
import { cursorOf, parseQuery } from "../conversations/common";
import { encodeCursor, toContactDto, toConversationSummary, toMessageDto } from "../conversations/dto";
import { enqueueAiRespond } from "../conversations/enqueue";
import { ContactsRepository, ConversationsRepository, MessagesRepository } from "../conversations/repos";
import { iso, type IntegrationsDeps } from "./common";

const limitParam = z.coerce.number().int().min(1).max(100).default(30);
const cursorParam = z.string().max(200).optional();

export const listConversationsSchema = z.strictObject({
  status: conversationStatusSchema.optional(),
  handler: conversationHandlerSchema.optional(),
  contactId: z.uuid().optional(),
  limit: limitParam,
  cursor: cursorParam,
});
const listMessagesSchema = z.strictObject({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const createConversationSchema = z.strictObject({
  contactId: z.uuid(),
  metadata: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 20, "Too many keys").optional(),
});
export const sendMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  /** agent = reply shown to the customer as a human; contact = a message from the customer (the AI answers); note = internal */
  sender: z.enum(["agent", "contact", "note"]).default("agent"),
  clientMessageId: z.string().min(1).max(64).optional(),
});
export const listBookingsSchema = z.strictObject({
  status: z.enum(["booked", "cancelled", "failed"]).optional(),
  contactId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: limitParam,
  cursor: cursorParam,
});

interface BookingRow {
  id: string; status: string; title: string; startAt: Date; endAt: Date; timezone: string | null; contactId: string | null;
  conversationId: string | null; attendeeEmail: string | null; notes: string | null; provider: string | null; eventUrl: string | null;
  cancelledAt: Date | null; createdAt: Date; cursorTs?: string;
}
const bookingCols = (tx: Tx) => tx`id, status, title, start_at, end_at, timezone, contact_id, conversation_id, attendee_email, notes, provider,
  event_url, cancelled_at, created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;
const bookingDto = (b: BookingRow) => ({
  id: b.id, status: b.status, title: b.title, startAt: iso(b.startAt)!, endAt: iso(b.endAt)!, timezone: b.timezone, contactId: b.contactId,
  conversationId: b.conversationId, attendeeEmail: b.attendeeEmail, notes: b.notes, provider: b.provider, eventUrl: b.eventUrl,
  cancelledAt: iso(b.cancelledAt), createdAt: iso(b.createdAt)!,
});

/**
 * Public API for tenant API keys: `Authorization: Bearer yl_...`, mounted at `/api/v1/public-api`.
 * Each key carries scopes and its own per-minute rate limit (enforced in `requireApiKey`).
 */
export function publicApiRoutes({ cfg, db, limiter }: IntegrationsDeps) {
  const r = new Hono<ApiKeyEnv>();
  const runtime = opsRuntimeFromEnv(cfg);
  /** The tenant's connected Google calendar, or null (bookings are then stored without an external event). */
  const calendarFor = async (tenantId: string, provider?: "google" | "calendly") =>
    cfg.encryptionKey
      ? loadTenantCalendarAny({
          db, encryptionKey: cfg.encryptionKey,
          google: runtime.google ? new GoogleCalendarClient(runtime.google, runtime.fetchImpl) : null,
          calendly: runtime.calendly ? new CalendlyClient(runtime.calendly, runtime.fetchImpl) : null,
        }, tenantId, provider)
      : null;
  r.use("*", requireApiKey(db, limiter)); // scoped to this router's mount prefix

  const audit = (tx: Tx, c: { get(k: "auth"): { tenantId: string }; get(k: "apiKey"): { id: string }; get(k: "requestId"): string; get(k: "ip"): string },
    action: string, type: string, id: string, extra: Record<string, unknown> = {}) =>
    new AuditLogRepository(tx, c.get("auth").tenantId).record({
      actorUserId: null, action, resourceType: type, resourceId: id, metadata: { via: "public_api", apiKeyId: c.get("apiKey").id, ...extra },
      ip: c.get("ip"), requestId: c.get("requestId"),
    });

  // ------------------------------------------------------------------ contacts
  r.get("/contacts", requireScope("contacts:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listContactsQuerySchema);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) => new ContactsRepository(tx, tenantId).list({ q: q.q, cursor, limit: q.limit }));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(toContactDto), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs, last.id) : null });
  });

  r.post("/contacts", requireScope("contacts:write"), async (c) => {
    const { tenantId } = c.get("auth");
    const body = await parseBody(c, createContactSchema);
    const attrs = Object.fromEntries(Object.entries(body.customAttributes ?? {}).filter(([, v]) => v !== null));
    const dto = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      const id = await repo.create({ ...body, customAttributes: attrs });
      await audit(tx, c, "contact.create", "contact", id);
      return toContactDto((await repo.get(id))!);
    });
    return c.json(dto, 201);
  });

  r.get("/contacts/:id", requireScope("contacts:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const row = await withTenant(db, tenantId, (tx) => new ContactsRepository(tx, tenantId).get(id));
    if (!row || (row as { mergedInto?: string | null }).mergedInto) throw Errors.notFound("Contact not found");
    return c.json(toContactDto(row));
  });

  r.patch("/contacts/:id", requireScope("contacts:write"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, updateContactSchema);
    const dto = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      const cur = await repo.get(id, true);
      if (!cur || (cur as { mergedInto?: string | null }).mergedInto) return null;
      let attrs: Record<string, unknown> | undefined;
      if (body.customAttributes) {
        attrs = { ...cur.customAttributes };
        for (const [k, v] of Object.entries(body.customAttributes)) {
          if (v === null) delete attrs[k];
          else attrs[k] = v;
        }
        if (Object.keys(attrs).length > 50) throw Errors.validation([{ path: "customAttributes", message: "Too many attributes" }]);
      }
      await repo.update(id, { name: body.name, email: body.email, phone: body.phone, customAttributes: attrs });
      await audit(tx, c, "contact.update", "contact", id, { fields: Object.keys(body) });
      return toContactDto((await repo.get(id))!);
    });
    if (!dto) throw Errors.notFound("Contact not found");
    return c.json(dto);
  });

  // ------------------------------------------------------------------ conversations
  r.get("/conversations", requireScope("conversations:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listConversationsSchema);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) =>
      new ConversationsRepository(tx, tenantId).list({ status: q.status, handler: q.handler, contactId: q.contactId, cursor, limit: q.limit }));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(toConversationSummary), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs!, last.id) : null });
  });

  r.post("/conversations", requireScope("conversations:write"), async (c) => {
    const { tenantId } = c.get("auth");
    const body = await parseBody(c, createConversationSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const contact = await new ContactsRepository(tx, tenantId).get(body.contactId);
      if (!contact || (contact as { mergedInto?: string | null }).mergedInto) throw Errors.notFound("Contact not found");
      await assertWithinLimit(tx, tenantId, "monthly_conversations");
      const convs = new ConversationsRepository(tx, tenantId);
      const id = await convs.create({ contactId: body.contactId, channel: "widget", metadata: { source: "api", ...(body.metadata ?? {}) } });
      await audit(tx, c, "conversation.create", "conversation", id, { contactId: body.contactId });
      return toConversationSummary((await convs.get(id))!);
    });
    return c.json(out, 201);
  });

  r.get("/conversations/:id", requireScope("conversations:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const row = await withTenant(db, tenantId, (tx) => new ConversationsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Conversation not found");
    return c.json(toConversationSummary(row));
  });

  /** Customer-visible messages only (contact / ai / human); internal notes and system lines are excluded. */
  r.get("/conversations/:id/messages", requireScope("conversations:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const q = parseQuery(c, listMessagesSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      if (!(await new ConversationsRepository(tx, tenantId).get(id))) return null;
      return new MessagesRepository(tx, tenantId).page(id, { before: q.before, limit: q.limit, visitorOnly: true });
    });
    if (!out) throw Errors.notFound("Conversation not found");
    const page = out.slice(0, q.limit);
    return c.json({ items: page.reverse().map(toMessageDto), nextCursor: out.length > q.limit ? page[0]!.id : null });
  });

  r.post("/conversations/:id/messages", requireScope("conversations:write"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, sendMessageSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const convs = new ConversationsRepository(tx, tenantId);
      const conv = await convs.get(id, true);
      if (!conv) return null;
      const messages = new MessagesRepository(tx, tenantId);
      const { id: messageId, created } = await messages.insert({
        conversationId: id,
        senderType: body.sender === "contact" ? "contact" : body.sender === "note" ? "note" : "human",
        content: body.text,
        clientMessageId: body.clientMessageId,
        metadata: { via: "public_api" },
      });
      if (created) {
        if (body.sender === "contact") {
          let status = conv.status;
          if (status === "resolved") {
            await convs.setState(id, { status: "open" });
            status = "open";
          }
          if (status === "open" && conv.handler === "ai") await enqueueAiRespond(tx, { tenantId, conversationId: id, messageId });
        }
        await audit(tx, c, "message.create", "message", messageId, { conversationId: id, sender: body.sender });
      }
      return { msg: (await messages.get(messageId))!, created };
    });
    if (!out) throw Errors.notFound("Conversation not found");
    return c.json(toMessageDto(out.msg), out.created ? 201 : 200);
  });

  // ------------------------------------------------------------------ bookings
  r.get("/bookings", requireScope("bookings:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listBookingsSchema);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) => tx<BookingRow[]>`
      SELECT ${bookingCols(tx)} FROM bookings WHERE tenant_id = ${tenantId}
        ${q.status ? tx`AND status = ${q.status}` : tx``}
        ${q.contactId ? tx`AND contact_id = ${q.contactId}` : tx``}
        ${q.conversationId ? tx`AND conversation_id = ${q.conversationId}` : tx``}
        ${q.from ? tx`AND start_at >= ${q.from}::timestamptz` : tx``}
        ${q.to ? tx`AND start_at < ${q.to}::timestamptz` : tx``}
        ${cursor ? tx`AND (created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : tx``}
      ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(bookingDto), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs!, last.id) : null });
  });

  r.get("/bookings/:id", requireScope("bookings:read"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const [row] = await withTenant(db, tenantId, (tx) => tx<BookingRow[]>`SELECT ${bookingCols(tx)} FROM bookings WHERE tenant_id = ${tenantId} AND id = ${id}`);
    if (!row) throw Errors.notFound("Booking not found");
    return c.json(bookingDto(row));
  });


  r.post("/bookings", requireScope("bookings:write"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, createBookingSchema);
    const start = new Date(b.startAt);
    const end = b.endAt ? new Date(b.endAt) : new Date(start.getTime() + (b.durationMinutes ?? 30) * 60_000);
    if (!(end > start)) throw Errors.validation([{ path: "endAt", message: "endAt must be after startAt" }]);
    if (end.getTime() - start.getTime() > 24 * 3_600_000) throw Errors.validation([{ path: "endAt", message: "Booking is too long" }]);
    try {
      const res = await bookSlot({ db, calendar: await calendarFor(tenantId), retry: runtime.calendarRetry }, tenantId, {
        startAt: start.toISOString(), endAt: end.toISOString(), title: b.title ?? "Appointment", contactId: b.contactId, conversationId: b.conversationId,
        attendeeEmail: b.attendeeEmail, timezone: b.timezone, notes: b.notes, createdBy: null, source: "human",
      });
      if (!res.ok && res.reason === "conflict") throw Errors.conflict("This time overlaps an existing booking");
      if (!res.ok) throw new AppError(503, "service_unavailable", "Calendar is unavailable; the booking was not created", { bookingId: res.booking.id });
      await withTenant(db, tenantId, (tx) => audit(tx, c, "booking.create", "booking", res.booking.id, { provider: res.booking.provider }));
      return c.json(bookingDto(res.booking as unknown as BookingRow), 201);
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "reference", message: "contact or conversation not found" }]);
      throw e;
    }
  });

  r.post("/bookings/:id/cancel", requireScope("bookings:write"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, cancelBookingSchema);
    const [prev] = await withTenant(db, tenantId, (tx) => tx<{ provider: string | null }[]>`SELECT provider FROM bookings WHERE tenant_id = ${tenantId} AND id = ${id}`);
    const res = await cancelBooking({ db, calendar: await calendarFor(tenantId, prev?.provider === "google" || prev?.provider === "calendly" ? prev.provider : undefined), retry: runtime.calendarRetry }, tenantId, id, b.reason);
    if (!res.ok) {
      if (res.reason === "not_found") throw Errors.notFound("Booking not found");
      if (res.reason === "already_cancelled") throw Errors.conflict("Booking is already cancelled");
      throw new AppError(503, "service_unavailable", "Calendar is unavailable; the booking was not cancelled");
    }
    await withTenant(db, tenantId, (tx) => audit(tx, c, "booking.cancel", "booking", id));
    return c.json(bookingDto(res.booking as unknown as BookingRow));
  });

  return r;
}
