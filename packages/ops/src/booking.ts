import { advanceTo, getOrCreateState } from "@yulona/ai-runtime";
import { withTenant, type Db, type Tx } from "@yulona/db";
import type { CalendarEventInput } from "@yulona/providers";
import { raiseSystemFailureHandoff } from "./handoff";
import { notifyRoles, notifyUser } from "./notify";
import { withRetry, type RetryOptions } from "./retry";

/** Structural calendar port: `CalendarProvider` plus optional abort signals (for timeouts). */
export interface BookingCalendar {
  readonly name: string;
  /** `offered: true` = no event was created; `url` is a single-use scheduling link the customer must open (Calendly free plan). */
  createEvent(e: CalendarEventInput & { attendeeName?: string }, signal?: AbortSignal): Promise<{ id: string; url?: string; offered?: boolean }>;
  cancelEvent(id: string, signal?: AbortSignal, reason?: string): Promise<void>;
}

export interface BookingDeps {
  db: Db;
  calendar: BookingCalendar | null;
  retry?: RetryOptions;
}
export interface BookingInput {
  startAt: string;
  endAt: string;
  title: string;
  contactId?: string | null;
  conversationId?: string | null;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  timezone?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  /** AI-initiated: a calendar failure raises a system_failure handoff. */
  source?: "ai" | "human";
}
export interface BookingRow {
  id: string;
  status: "booked" | "cancelled" | "failed" | "offered";
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string | null;
  contactId: string | null;
  conversationId: string | null;
  attendeeEmail: string | null;
  notes: string | null;
  provider: string | null;
  externalEventId: string | null;
  eventUrl: string | null;
  failureReason: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
}
export type BookResult =
  | { ok: true; booking: BookingRow }
  | { ok: false; reason: "conflict" }
  | { ok: false; reason: "calendar_failed"; booking: BookingRow; error: string; handoffId: string | null };

export const BOOKING_COLUMNS = (tx: Tx) => tx`id, status, title, start_at, end_at, timezone, contact_id, conversation_id, attendee_email, notes,
  provider, external_event_id, event_url, failure_reason, cancelled_at, created_at`;

const retryable = (e: unknown) => {
  const s = (e as { status?: number }).status;
  return s === undefined || s >= 500 || s === 429;
};

/**
 * Book a slot. Phase 1 (tx): serialise per tenant, reject overlaps with other booked slots, insert the row.
 * Phase 2 (no tx held): create the calendar event with timeout + exponential backoff.
 * Phase 3 (tx): record the outcome; on success advance the conversation to `booked`; on failure mark the booking
 * `failed`, notify admins and (AI-initiated, AI-handled conversation) raise a `system_failure` handoff.
 */
export async function bookSlot(deps: BookingDeps, tenantId: string, input: BookingInput): Promise<BookResult> {
  const created = await withTenant(deps.db, tenantId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"bookings:" + tenantId}))`;
    const [clash] = await tx`
      SELECT 1 FROM bookings WHERE tenant_id = ${tenantId} AND status = 'booked'
        AND start_at < ${input.endAt}::timestamptz AND end_at > ${input.startAt}::timestamptz LIMIT 1`;
    if (clash) return null;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO bookings (tenant_id, status, title, start_at, end_at, timezone, contact_id, conversation_id, attendee_email, notes, provider, created_by)
      VALUES (${tenantId}, 'booked', ${input.title}, ${input.startAt}, ${input.endAt}, ${input.timezone ?? null}, ${input.contactId ?? null},
              ${input.conversationId ?? null}, ${input.attendeeEmail ?? null}, ${input.notes ?? null}, ${deps.calendar?.name ?? null}, ${input.createdBy ?? null})
      RETURNING id`;
    return row!.id;
  });
  if (!created) return { ok: false, reason: "conflict" };

  let event: { id: string; url?: string; offered?: boolean } | null = null;
  let failure: string | null = null;
  if (deps.calendar) {
    const cal = deps.calendar;
    try {
      event = await withRetry(
        (signal) => cal.createEvent({
          title: input.title, start: input.startAt, end: input.endAt, attendeeEmail: input.attendeeEmail ?? undefined, attendeeName: input.attendeeName ?? undefined,
          description: input.notes ?? undefined, timezone: input.timezone ?? undefined,
        }, signal),
        { retryable, ...deps.retry },
      );
    } catch (e) {
      failure = `calendar unavailable: ${(e as Error).message}`.slice(0, 300);
    }
  }

  return withTenant(deps.db, tenantId, async (tx) => {
    if (failure) {
      await tx`UPDATE bookings SET status = 'failed', failure_reason = ${failure}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${created}`;
      const handoffId = input.source === "ai" && input.conversationId
        ? await raiseSystemFailureHandoff(tx, tenantId, input.conversationId, `booking failed: ${failure}`, { bookingId: created })
        : null;
      await notifyRoles(tx, tenantId, ["owner", "admin"], {
        type: "booking.failed", title: "Booking could not be created", body: failure, data: { bookingId: created, conversationId: input.conversationId ?? null }, email: true,
      });
      const [b] = await tx<BookingRow[]>`SELECT ${BOOKING_COLUMNS(tx)} FROM bookings WHERE tenant_id = ${tenantId} AND id = ${created}`;
      return { ok: false as const, reason: "calendar_failed" as const, booking: b!, error: failure, handoffId };
    }
    if (event?.offered) {
      // A scheduling link was sent; nothing is booked until the customer picks a time, so the slot stays free and the stage is unchanged.
      await tx`UPDATE bookings SET status = 'offered', event_url = ${event.url ?? null}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${created}`;
      const [b] = await tx<BookingRow[]>`SELECT ${BOOKING_COLUMNS(tx)} FROM bookings WHERE tenant_id = ${tenantId} AND id = ${created}`;
      return { ok: true as const, booking: b! };
    }
    if (event) {
      await tx`UPDATE bookings SET external_event_id = ${event.id}, event_url = ${event.url ?? null}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${created}`;
    }
    if (input.conversationId) await markConversationBooked(tx, tenantId, input.conversationId);
    const data = { bookingId: created, conversationId: input.conversationId ?? null };
    if (input.createdBy) await notifyUser(tx, tenantId, input.createdBy, { type: "booking.created", title: `Booking: ${input.title}`, data });
    else await notifyRoles(tx, tenantId, ["owner", "admin"], { type: "booking.created", title: `Booking: ${input.title}`, body: input.startAt, data });
    const [b] = await tx<BookingRow[]>`SELECT ${BOOKING_COLUMNS(tx)} FROM bookings WHERE tenant_id = ${tenantId} AND id = ${created}`;
    return { ok: true as const, booking: b! };
  });
}

/** Advance the conversation's funnel stage to `booked` when legal (silently skipped otherwise, e.g. after a handoff). */
export async function markConversationBooked(tx: Tx, tenantId: string, conversationId: string): Promise<void> {
  const state = await getOrCreateState(tx, tenantId, conversationId);
  try {
    await advanceTo(tx, tenantId, conversationId, state.stage, "booked", "booking_confirmed");
  } catch {
    /* illegal from the current stage (handoff_requested, already booked): leave the stage alone */
  }
}

export type CancelResult = { ok: true; booking: BookingRow } | { ok: false; reason: "not_found" | "already_cancelled" } | { ok: false; reason: "calendar_failed"; error: string };

export async function cancelBooking(deps: BookingDeps, tenantId: string, id: string, reason: string | undefined): Promise<CancelResult> {
  const cur = await withTenant(deps.db, tenantId, async (tx) => {
    const [b] = await tx<{ status: string; externalEventId: string | null }[]>`
      SELECT status, external_event_id FROM bookings WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    return b ?? null;
  });
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.status === "cancelled") return { ok: false, reason: "already_cancelled" };
  if (cur.externalEventId && deps.calendar) {
    const cal = deps.calendar;
    const eventId = cur.externalEventId;
    try {
      await withRetry((signal) => cal.cancelEvent(eventId, signal, reason), { retryable, ...deps.retry });
    } catch (e) {
      return { ok: false, reason: "calendar_failed", error: (e as Error).message.slice(0, 300) };
    }
  }
  return withTenant(deps.db, tenantId, async (tx) => {
    await tx`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), notes = COALESCE(${reason ?? null}, notes), updated_at = now()
             WHERE tenant_id = ${tenantId} AND id = ${id}`;
    const [b] = await tx<BookingRow[]>`SELECT ${BOOKING_COLUMNS(tx)} FROM bookings WHERE tenant_id = ${tenantId} AND id = ${id}`;
    return { ok: true as const, booking: b! };
  });
}
