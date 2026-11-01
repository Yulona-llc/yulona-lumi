import { z } from "zod";

// ---------- enums ----------
export const TICKET_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export const BOOKING_STATUSES = ["booked", "cancelled", "failed", "offered"] as const;
export const HANDOFF_TYPES = ["uncertainty", "stage", "system_failure", "abuse"] as const;
export const AVAILABILITY_STATUSES = ["online", "away", "offline"] as const;
export const availabilityStatusSchema = z.enum(AVAILABILITY_STATUSES);
export const OUT_OF_HOURS_MODES = ["ai_only", "message", "queue"] as const;
export const ASSIGNMENT_MODES = ["manual", "least_busy"] as const;
export const NOTIFICATION_TYPES = ["handoff.requested", "handoff.assigned", "ticket.assigned", "ticket.sla_breached", "booking.created", "booking.failed"] as const;

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().max(200).transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(values)).min(1).max(values.length));
export const opsLimitSchema = z.coerce.number().int().min(1).max(100).default(30);
const cursor = z.string().max(300).optional();
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

// ---------- tickets ----------
export const createTicketSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeUserId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  conversationId: z.uuid().nullable().optional(),
  dueAt: z.iso.datetime().nullable().optional(),
});
export const updateTicketSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(8000),
    status: ticketStatusSchema,
    priority: ticketPrioritySchema,
    assigneeUserId: z.uuid().nullable(),
    contactId: z.uuid().nullable(),
    conversationId: z.uuid().nullable(),
    dueAt: z.iso.datetime().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const ticketFilterSchema = z.strictObject({
  status: csv(TICKET_STATUSES).optional(),
  priority: csv(TICKET_PRIORITIES).optional(),
  assignee: z.union([z.enum(["me", "unassigned"]), z.uuid()]).optional(),
  contactId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  slaBreached: bool.optional(),
});
export const listTicketsQuerySchema = ticketFilterSchema.extend({ limit: opsLimitSchema, cursor });
export const ticketBoardQuerySchema = ticketFilterSchema.omit({ status: true });
export const ticketCommentSchema = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export const ticketEventsQuerySchema = z.strictObject({ limit: opsLimitSchema, cursor });
export const bulkTicketsSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(100),
  action: z.enum(["set_status", "set_priority", "assign", "delete"]),
  value: z.string().max(40).nullable().optional(),
});

// ---------- bookings ----------
export const createBookingSchema = z
  .strictObject({
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    contactId: z.uuid().nullable().optional(),
    conversationId: z.uuid().nullable().optional(),
    attendeeEmail: z.string().email().max(254).optional(),
    timezone: z.string().max(64).optional(),
    notes: z.string().max(2000).optional(),
    /** Force one connected calendar (default: the workspace's default calendar). */
    provider: z.enum(["google", "calendly"]).optional(),
  })
  .refine((v) => !(v.endAt && v.durationMinutes), "Provide endAt or durationMinutes, not both");
export const cancelBookingSchema = z.strictObject({ reason: z.string().max(500).optional() });
export const listBookingsQuerySchema = z.strictObject({
  status: csv(BOOKING_STATUSES).optional(),
  contactId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: opsLimitSchema,
  cursor,
});
export const availabilityQuerySchema = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  durationMinutes: z.coerce.number().int().min(5).max(480).default(30),
  timezone: z.string().max(64).optional(),
  provider: z.enum(["google", "calendly"]).optional(),
});
export const CALENDAR_PROVIDERS = ["google", "calendly"] as const;
export const setCalendlyEventTypeSchema = z.strictObject({ eventTypeUri: z.string().trim().url().max(300) });
export const setDefaultCalendarSchema = z.strictObject({ provider: z.enum(CALENDAR_PROVIDERS) });
export const updateCalendarConnectionSchema = z.strictObject({ calendarId: z.string().trim().min(1).max(200) });

// ---------- Needs Attention ----------
export const listHandoffsQuerySchema = z.strictObject({
  state: z.enum(["open", "claimed", "resolved", "active"]).default("active"),
  type: csv(HANDOFF_TYPES).optional(),
  assignee: z.union([z.enum(["me", "unassigned"]), z.uuid()]).optional(),
  limit: opsLimitSchema,
  cursor,
});
export const claimHandoffSchema = z.strictObject({ force: z.boolean().optional() });
export const assignHandoffSchema = z.strictObject({ userId: z.uuid() });
export const resolveHandoffSchema = z.strictObject({ note: z.string().max(2000).optional(), returnToAi: z.boolean().optional() });

// ---------- availability / settings ----------
export const setAvailabilitySchema = z.strictObject({ status: availabilityStatusSchema });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "HH:MM");
export const businessHourSchema = z.strictObject({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm });
export const opsSettingsUpdateSchema = z
  .strictObject({
    timezone: z.string().min(1).max(64),
    slaMinutes: z.strictObject({
      urgent: z.number().int().min(1).max(525_600),
      high: z.number().int().min(1).max(525_600),
      normal: z.number().int().min(1).max(525_600),
      low: z.number().int().min(1).max(525_600),
    }),
    outOfHours: z.strictObject({ mode: z.enum(OUT_OF_HOURS_MODES), message: z.string().max(1000).nullable().optional() }),
    assignment: z.strictObject({ mode: z.enum(ASSIGNMENT_MODES) }),
    holidays: z.array(z.iso.date()).max(100),
    businessHours: z.array(businessHourSchema).max(28),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");

// ---------- canned responses / tags / notifications ----------
export const cannedShortcutSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const createCannedSchema = z.strictObject({
  shortcut: cannedShortcutSchema,
  title: z.string().trim().min(1).max(100),
  content: z.string().min(1).max(4000),
});
export const updateCannedSchema = createCannedSchema.partial().refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const listCannedQuerySchema = z.strictObject({ q: z.string().trim().min(1).max(100).optional(), limit: opsLimitSchema, cursor });
export const createTagSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export const updateTagSchema = createTagSchema.partial().refine((v) => Object.keys(v).length > 0, "At least one field is required");
export const setTagsSchema = z.strictObject({ tagIds: z.array(z.uuid()).max(20) });
export const tagResourcesQuerySchema = z.strictObject({ type: z.enum(["conversation", "contact", "ticket"]), limit: opsLimitSchema, cursor });
export const listNotificationsQuerySchema = z.strictObject({ unread: bool.optional(), limit: opsLimitSchema, cursor });
export const notificationPrefsSchema = z.strictObject({ email: z.boolean() });
