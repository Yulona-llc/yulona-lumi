import { advanceTo, getOrCreateState } from "@yulona/ai-runtime";
import type { ToolManifest } from "@yulona/shared";
import { withTenant, type Db } from "@yulona/db";
import type { CalendarProvider, TimeSlot } from "@yulona/providers";
import { bookSlot, type BookingCalendar } from "./booking";
import { raiseSystemFailureHandoff } from "./handoff";
import { withRetry, type RetryOptions } from "./retry";

type Json = Record<string, unknown>;

/**
 * ToolManifest definitions for the calendar tools. Register them in the AI tool registry (see docs/api/ops.md);
 * execution is in-process through `executeCalendarTool` (they need DB + tenant calendar credentials, so they cannot
 * be plain HTTP custom tools).
 */
export const CALENDAR_TOOL_MANIFESTS: Record<"check_availability" | "book_appointment", ToolManifest> = {
  check_availability: {
    version: 1,
    name: "check_availability",
    description: "Look up free appointment slots on the team calendar. Offer 2-4 of the returned slots to the customer.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", maxLength: 40 },
        to: { type: "string", maxLength: 40 },
        duration_minutes: { type: "integer", minimum: 5, maximum: 480 },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    authType: "none",
    allowedStages: ["engaged", "qualified", "booking_offered"],
  },
  book_appointment: {
    version: 1,
    name: "book_appointment",
    description: "Book one of the slots returned by check_availability after the customer confirmed it. start must be a slot start exactly as returned.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", maxLength: 40 },
        duration_minutes: { type: "integer", minimum: 5, maximum: 480 },
        attendee_email: { type: "string", maxLength: 254 },
        title: { type: "string", maxLength: 200 },
      },
      required: ["start"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    authType: "none",
    allowedStages: ["qualified", "booking_offered"],
  },
};

export interface CalendarToolContext {
  db: Db;
  tenantId: string;
  conversationId: string;
  calendar: (CalendarProvider & BookingCalendar & { availability(q: { from: string; to: string; durationMinutes: number }, signal?: AbortSignal): Promise<TimeSlot[]>; eventDuration?(signal?: AbortSignal): Promise<number | null> }) | null;
  retry?: RetryOptions;
  now?: () => Date;
}
export interface CalendarToolResult {
  /** ok: result for the model; rejected: model error (retry differently); failed: system failure (handoff raised) */
  kind: "ok" | "rejected" | "failed";
  output?: Json;
  error?: string;
}

const retryable = (e: unknown) => {
  const s = (e as { status?: number }).status;
  return s === undefined || s >= 500 || s === 429;
};
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const pickSpread = (slots: TimeSlot[], n: number): TimeSlot[] => {
  if (slots.length <= n) return slots;
  return Array.from({ length: n }, (_, i) => slots[Math.floor((i * slots.length) / n)]!);
};

/** Providers whose event types have a fixed length (Calendly) override the model's duration. */
async function fixedDuration(cal: NonNullable<CalendarToolContext["calendar"]>, requested: number, retry?: RetryOptions): Promise<number> {
  if (!cal.eventDuration) return requested;
  try {
    return (await withRetry((s) => cal.eventDuration!(s), { retryable, ...retry })) ?? requested;
  } catch {
    return requested; // availability/booking will surface the real failure
  }
}

async function failWithHandoff(c: CalendarToolContext, tool: string, e: unknown): Promise<CalendarToolResult> {
  const msg = `calendar tool ${tool} failed: ${(e as Error).message}`.slice(0, 300);
  await withTenant(c.db, c.tenantId, (tx) => raiseSystemFailureHandoff(tx, c.tenantId, c.conversationId, msg, { tool }));
  return { kind: "failed", error: msg };
}

export async function executeCalendarTool(c: CalendarToolContext, name: string, input: Json): Promise<CalendarToolResult> {
  const now = (c.now ?? (() => new Date()))();
  if (!c.calendar) return { kind: "rejected", error: "calendar_not_connected" };
  const cal = c.calendar;
  if (name === "check_availability") {
    const from = isIso(input.from) ? new Date(input.from) : new Date(now.getTime() + 15 * 60_000);
    const to = isIso(input.to) ? new Date(input.to) : new Date(from.getTime() + 7 * 86_400_000);
    let duration = typeof input.duration_minutes === "number" ? input.duration_minutes : 30;
    duration = await fixedDuration(cal, duration, c.retry);
    if (to <= from || to.getTime() - from.getTime() > 14 * 86_400_000) return { kind: "rejected", error: "invalid_range (max 14 days)" };
    let slots: TimeSlot[];
    try {
      slots = await withRetry((s) => cal.availability({ from: from.toISOString(), to: to.toISOString(), durationMinutes: duration }, s), { retryable, ...c.retry });
    } catch (e) {
      return failWithHandoff(c, name, e);
    }
    if (slots.length) {
      await withTenant(c.db, c.tenantId, async (tx) => {
        const st = await getOrCreateState(tx, c.tenantId, c.conversationId);
        try { await advanceTo(tx, c.tenantId, c.conversationId, st.stage, "booking_offered", "booking_offered"); } catch { /* not legal from this stage */ }
      });
    }
    return { kind: "ok", output: { slots: pickSpread(slots, 6), total: slots.length, durationMinutes: duration } };
  }
  if (name === "book_appointment") {
    if (!isIso(input.start)) return { kind: "rejected", error: "invalid_start" };
    const duration = await fixedDuration(cal, typeof input.duration_minutes === "number" ? input.duration_minutes : 30, c.retry);
    const start = new Date(input.start);
    const end = new Date(start.getTime() + duration * 60_000);
    if (start.getTime() < now.getTime()) return { kind: "rejected", error: "start_in_past" };
    // The slot must still be free on the calendar and inside business hours.
    let free: TimeSlot[];
    try {
      free = await withRetry((s) => cal.availability({ from: start.toISOString(), to: end.toISOString(), durationMinutes: duration }, s), { retryable, ...c.retry });
    } catch (e) {
      return failWithHandoff(c, name, e);
    }
    if (!free.some((s) => Date.parse(s.start) === start.getTime())) return { kind: "rejected", error: "slot_unavailable" };
    const ctx = await withTenant(c.db, c.tenantId, async (tx) => {
      const [r] = await tx<{ contactId: string; email: string | null; name: string | null }[]>`
        SELECT c.contact_id, ct.email, ct.name FROM conversations c JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE c.tenant_id = ${c.tenantId} AND c.id = ${c.conversationId}`;
      return r;
    });
    if (!ctx) return { kind: "rejected", error: "conversation_not_found" };
    const attendee = typeof input.attendee_email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.attendee_email) ? input.attendee_email : ctx.email;
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : `Appointment with ${ctx.name ?? "customer"}`;
    const r = await bookSlot({ db: c.db, calendar: cal, retry: c.retry }, c.tenantId, {
      startAt: start.toISOString(), endAt: end.toISOString(), title, contactId: ctx.contactId, conversationId: c.conversationId,
      attendeeEmail: attendee, attendeeName: ctx.name, source: "ai",
    });
    if (r.ok && r.booking.status === "offered") {
      return { kind: "ok", output: { booked: false, schedulingLink: r.booking.eventUrl, note: "Not booked yet: send this single-use link to the customer so they can pick and confirm a time themselves." } };
    }
    if (r.ok) return { kind: "ok", output: { booked: true, bookingId: r.booking.id, start: start.toISOString(), end: end.toISOString(), eventUrl: r.booking.eventUrl } };
    if (r.reason === "conflict") return { kind: "rejected", error: "slot_unavailable" };
    return { kind: "failed", error: r.error };
  }
  return { kind: "rejected", error: "unknown_tool" };
}
