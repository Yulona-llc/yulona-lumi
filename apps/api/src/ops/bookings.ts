import { Hono } from "hono";
import { withTenant, type Tx } from "@yulona/db";
import {
  bookSlot, cancelBooking, CalendlyClient, GoogleCalendarClient, loadTenantCalendarAny, sealTokens, signState, verifyState, withRetry, type BookingRow,
} from "@yulona/ops";
import { availabilityQuerySchema, cancelBookingSchema, createBookingSchema, listBookingsQuerySchema, updateCalendarConnectionSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { audit, isFkViolation, parseId, parseQuery } from "../platform/util";
import { decodeCur, encodeCur, guard, iso, TS_FMT, type OpsDeps } from "./common";

const dto = (b: BookingRow & { contactName?: string | null }) => ({
  id: b.id, status: b.status, title: b.title, startAt: iso(b.startAt), endAt: iso(b.endAt), timezone: b.timezone, contactId: b.contactId,
  contactName: b.contactName ?? null, conversationId: b.conversationId, attendeeEmail: b.attendeeEmail, notes: b.notes, provider: b.provider,
  externalEventId: b.externalEventId, eventUrl: b.eventUrl, failureReason: b.failureReason, cancelledAt: iso(b.cancelledAt), createdAt: iso(b.createdAt),
});
const select = (tx: Tx) => tx`
  b.id, b.status, b.title, b.start_at, b.end_at, b.timezone, b.contact_id, c.name AS contact_name, b.conversation_id, b.attendee_email, b.notes, b.provider,
  b.external_event_id, b.event_url, b.failure_reason, b.cancelled_at, b.created_at,
  to_char(b.start_at AT TIME ZONE 'UTC', ${TS_FMT}) AS start_ts, to_char(b.created_at AT TIME ZONE 'UTC', ${TS_FMT}) AS created_ts
  FROM bookings b LEFT JOIN contacts c ON c.tenant_id = b.tenant_id AND c.id = b.contact_id`;

const retryable = (e: unknown) => {
  const s = (e as { status?: number }).status;
  return s === undefined || s >= 500 || s === 429;
};

export function bookingRoutes(deps: OpsDeps) {
  const { cfg, db, runtime } = deps;
  const r = new Hono<AppEnv>();

  const google = () => (runtime.google ? new GoogleCalendarClient(runtime.google, runtime.fetchImpl) : null);
  const calendly = () => (runtime.calendly ? new CalendlyClient(runtime.calendly, runtime.fetchImpl) : null);
  /** The tenant's default connected calendar (Google or Calendly), or one forced provider. */
  const tenantCalendar = async (tenantId: string, provider?: "google" | "calendly") =>
    cfg.encryptionKey ? loadTenantCalendarAny({ db, encryptionKey: cfg.encryptionKey, google: google(), calendly: calendly() }, tenantId, provider) : null;

  // ---- bookings --------------------------------------------------------------------------------
  r.get("/bookings", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listBookingsQuerySchema);
    const cur = decodeCur(q.cursor);
    const upcoming = !!q.from;
    const rows = await withTenant(db, tenantId, (tx) => tx<(BookingRow & { contactName: string | null; startTs: string; createdTs: string })[]>`
      SELECT ${select(tx)} WHERE b.tenant_id = ${tenantId}
        ${q.status ? tx`AND b.status = ANY(${tx.array(q.status as string[])}::text[])` : tx``}
        ${q.contactId ? tx`AND b.contact_id = ${q.contactId}` : tx``}
        ${q.conversationId ? tx`AND b.conversation_id = ${q.conversationId}` : tx``}
        ${q.from ? tx`AND b.start_at >= ${q.from}::timestamptz` : tx``}
        ${q.to ? tx`AND b.start_at <= ${q.to}::timestamptz` : tx``}
        ${cur ? (upcoming ? tx`AND (b.start_at, b.id) > (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx`AND (b.created_at, b.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`) : tx``}
      ${upcoming ? tx`ORDER BY b.start_at, b.id` : tx`ORDER BY b.created_at DESC, b.id DESC`} LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(dto), nextCursor: rows.length > q.limit && last ? encodeCur(upcoming ? last.startTs : last.createdTs, last.id) : null });
  });

  r.get("/bookings/availability", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, availabilityQuerySchema);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from) || to.getTime() - from.getTime() > 14 * 86_400_000) throw Errors.validation([{ path: "to", message: "Range must be positive and at most 14 days" }]);
    const cal = await tenantCalendar(tenantId);
    if (!cal) throw new AppError(409, "conflict", "Calendar is not connected", { reason: "calendar_not_connected" });
    try {
      const slots = await withRetry((s) => cal.availability({ from: q.from, to: q.to, durationMinutes: q.durationMinutes, timezone: q.timezone }, s), { retryable, ...runtime.calendarRetry });
      return c.json({ slots, source: cal.name as "google" | "calendly" });
    } catch (e) {
      deps.log.warn("calendar availability failed", { tenantId, err: (e as Error).message });
      throw new AppError(503, "service_unavailable", "Calendar is temporarily unavailable");
    }
  });

  r.post("/bookings", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, createBookingSchema);
    const start = new Date(b.startAt);
    const end = b.endAt ? new Date(b.endAt) : new Date(start.getTime() + (b.durationMinutes ?? 30) * 60_000);
    if (!(end > start)) throw Errors.validation([{ path: "endAt", message: "endAt must be after startAt" }]);
    if (end.getTime() - start.getTime() > 24 * 3_600_000) throw Errors.validation([{ path: "endAt", message: "Booking is too long" }]);
    const cal = await tenantCalendar(tenantId);
    try {
      const res = await bookSlot({ db, calendar: cal, retry: runtime.calendarRetry }, tenantId, {
        startAt: start.toISOString(), endAt: end.toISOString(), title: b.title ?? "Appointment", contactId: b.contactId, conversationId: b.conversationId,
        attendeeEmail: b.attendeeEmail, timezone: b.timezone, notes: b.notes, createdBy: userId, source: "human",
      });
      if (!res.ok && res.reason === "conflict") throw Errors.conflict("This time overlaps an existing booking");
      if (!res.ok) throw new AppError(503, "service_unavailable", "Calendar is unavailable; the booking was not created", { bookingId: res.booking.id });
      const full = await withTenant(db, tenantId, async (tx) => {
        await audit(tx, c, "booking.create", "booking", res.booking.id, { provider: res.booking.provider });
        return (await tx<(BookingRow & { contactName: string | null })[]>`SELECT ${select(tx)} WHERE b.tenant_id = ${tenantId} AND b.id = ${res.booking.id}`)[0]!;
      });
      return c.json(dto(full), 201);
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "reference", message: "contact or conversation not found" }]);
      throw e;
    }
  });

  r.get("/bookings/:id", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const [b] = await withTenant(db, tenantId, (tx) => tx<(BookingRow & { contactName: string | null })[]>`SELECT ${select(tx)} WHERE b.tenant_id = ${tenantId} AND b.id = ${id}`);
    if (!b) throw Errors.notFound("Booking not found");
    return c.json(dto(b));
  });

  r.post("/bookings/:id/cancel", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, cancelBookingSchema);
    const [prev] = await withTenant(db, tenantId, (tx) => tx<{ provider: string | null }[]>`SELECT provider FROM bookings WHERE tenant_id = ${tenantId} AND id = ${id}`);
    const cal = await tenantCalendar(tenantId, prev?.provider === "google" || prev?.provider === "calendly" ? prev.provider : undefined);
    const res = await cancelBooking({ db, calendar: cal, retry: runtime.calendarRetry }, tenantId, id, b.reason);
    if (!res.ok) {
      if (res.reason === "not_found") throw Errors.notFound("Booking not found");
      if (res.reason === "already_cancelled") throw Errors.conflict("Booking is already cancelled");
      throw new AppError(503, "service_unavailable", "Calendar is unavailable; the booking was not cancelled");
    }
    await withTenant(db, tenantId, (tx) => audit(tx, c, "booking.cancel", "booking", id));
    return c.json(dto(res.booking));
  });

  // ---- Google Calendar connection ------------------------------------------------------------------
  const connDto = (x: { provider: string; accountEmail: string | null; calendarId: string; status: string; createdAt: Date } | undefined) =>
    x ? { connected: true, provider: x.provider, accountEmail: x.accountEmail, calendarId: x.calendarId, status: x.status, connectedAt: iso(x.createdAt) } : { connected: false };

  r.get("/calendar/connection", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const [x] = await withTenant(db, tenantId, (tx) => tx<{ provider: string; accountEmail: string | null; calendarId: string; status: string; createdAt: Date }[]>`
      SELECT provider, account_email, calendar_id, status, created_at FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = 'google'`);
    return c.json(connDto(x));
  });

  r.post("/calendar/google/connect", guard(cfg, "admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const g = google();
    if (!g || !cfg.encryptionKey) throw new AppError(503, "service_unavailable", "Google Calendar is not configured (GOOGLE_CLIENT_ID/SECRET, ENCRYPTION_KEY)");
    return c.json({ url: g.authorizeUrl(signState(cfg.jwtSecret, { tenantId, userId })) });
  });

  /** Public: Google redirects the browser here. Tenant comes from the signed state only. */
  r.get("/calendar/google/callback", async (c) => {
    const back = (q: string) => c.redirect(`${cfg.appUrl.replace(/\/+$/, "")}/settings/integrations?${q}`, 302);
    const g = google();
    const state = verifyState(cfg.jwtSecret, c.req.query("state") ?? "");
    const code = c.req.query("code");
    if (!g || !cfg.encryptionKey || !state) return back("calendar=error&reason=invalid_state");
    if (c.req.query("error") || !code) return back("calendar=error&reason=denied");
    try {
      const tokens = await withRetry((s) => g.exchangeCode(code, s), { retryable, attempts: 2, ...runtime.calendarRetry });
      const email = await g.calendarEmail(tokens.accessToken, "primary").catch(() => null);
      await withTenant(db, state.tenantId, async (tx) => {
        await tx`UPDATE calendar_connections SET is_default = false WHERE tenant_id = ${state.tenantId} AND provider <> 'google'`;
        await tx`
          INSERT INTO calendar_connections (tenant_id, provider, account_email, calendar_id, credentials_encrypted, status, connected_by, is_default)
          VALUES (${state.tenantId}, 'google', ${email}, 'primary', ${sealTokens(cfg.encryptionKey!, state.tenantId, tokens)}, 'active', ${state.userId}, true)
          ON CONFLICT (tenant_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, credentials_encrypted = EXCLUDED.credentials_encrypted,
            status = 'active', last_error = NULL, connected_by = EXCLUDED.connected_by, is_default = true, updated_at = now()`;
        await tx`INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, metadata, ip, request_id)
                 VALUES (${state.tenantId}, ${state.userId}, 'calendar.connect', 'calendar', 'google', ${tx.json({ accountEmail: email } as never)}, ${c.get("ip")}, ${c.get("requestId")})`;
      });
      return back("calendar=connected");
    } catch (e) {
      deps.log.warn("google calendar connect failed", { err: (e as Error).message });
      return back("calendar=error&reason=exchange_failed");
    }
  });

  r.patch("/calendar/connection", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, updateCalendarConnectionSchema);
    const x = await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx<{ provider: string; accountEmail: string | null; calendarId: string; status: string; createdAt: Date }[]>`
        UPDATE calendar_connections SET calendar_id = ${b.calendarId}, updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'google'
        RETURNING provider, account_email, calendar_id, status, created_at`;
      if (row) await audit(tx, c, "calendar.update", "calendar", "google", { calendarId: b.calendarId });
      return row;
    });
    if (!x) throw Errors.notFound("Calendar is not connected");
    return c.json(connDto(x));
  });

  r.delete("/calendar/connection", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`DELETE FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = 'google' RETURNING provider`;
      if (rows.length) await audit(tx, c, "calendar.disconnect", "calendar", "google");
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("Calendar is not connected");
    return c.json({ ok: true as const });
  });
  return r;
}
