import { z } from "zod";
import {
  assignHandoffSchema, bulkTicketsSchema, cancelBookingSchema, claimHandoffSchema, createBookingSchema, createCannedSchema, createTagSchema, createTicketSchema,
  errorEnvelopeSchema, notificationPrefsSchema, opsSettingsUpdateSchema, resolveHandoffSchema,
  setAvailabilitySchema, setTagsSchema, ticketCommentSchema, updateCannedSchema, updateTagSchema, updateTicketSchema,
  updateCalendarConnectionSchema, setCalendlyEventTypeSchema, setDefaultCalendarSchema,
  connectHubspotSchema, updateHubspotMappingSchema, hubspotTestContactSchema,
} from "@yulona/shared";

const j = (s: z.ZodType) => z.toJSONSchema(s, { target: "openapi-3.0", io: "input", unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s) } } });
const out = (description: string, example?: unknown) => ({ description, ...(example ? { content: { "application/json": { example } } } : {}) });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema) } } });
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const page = [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "cursor", in: "query", schema: { type: "string" } }];
const sec = [{ bearerAuth: [] }];
const E = { 400: err("Validation error"), 401: err("Unauthorized"), 403: err("Forbidden"), 404: err("Not found") };
const op = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, security: sec, tags: ["ops"], responses: { 200: out("OK"), ...E }, ...extra });

/** OpenAPI path items for the ops area (contract details: docs/api/ops.md). */
export function opsPaths(): Record<string, unknown> {
  const crud = (base: string, name: string, create: z.ZodType, update?: z.ZodType, getOne = true) => ({
    [`/api/v1/${base}`]: { get: op(`List ${name}`, { parameters: page }), post: op(`Create ${name}`, { requestBody: body(create), responses: { 201: out("Created"), ...E } }) },
    [`/api/v1/${base}/{id}`]: {
      ...(getOne ? { get: op(`Get ${name}`, { parameters: [id] }) } : {}),
      ...(update ? { patch: op(`Update ${name}`, { parameters: [id], requestBody: body(update) }) } : {}),
      delete: op(`Delete ${name}`, { parameters: [id] }),
    },
  });
  return {
    ...crud("tickets", "tickets", createTicketSchema, updateTicketSchema),
    "/api/v1/tickets/board": { get: op("Kanban board (columns by status)") },
    "/api/v1/tickets/bulk": { post: op("Bulk status/priority/assign/delete", { requestBody: body(bulkTicketsSchema) }) },
    "/api/v1/tickets/{id}/comments": { post: op("Add a comment", { parameters: [id], requestBody: body(ticketCommentSchema), responses: { 201: out("Created"), ...E } }) },
    "/api/v1/tickets/{id}/events": { get: op("Ticket audit trail", { parameters: [id, ...page] }) },
    "/api/v1/bookings": { get: op("List bookings", { parameters: page }), post: op("Create booking on the default calendar, or on `provider` when both are connected (Google event, Calendly invitee, or a single-use Calendly link: status `offered`)", { requestBody: body(createBookingSchema), responses: { 201: out("Created"), 409: err("Overlap"), 503: err("Calendar unavailable"), ...E } }) },
    "/api/v1/bookings/availability": { get: op("Free slots from the default calendar (or `provider`) within business hours") },
    "/api/v1/bookings/{id}": { get: op("Get booking", { parameters: [id] }) },
    "/api/v1/bookings/{id}/cancel": { post: op("Cancel booking", { parameters: [id], requestBody: body(cancelBookingSchema) }) },
    "/api/v1/calendar/connection": { get: op("Calendar connection status"), patch: op("Choose calendar", { requestBody: body(updateCalendarConnectionSchema) }), delete: op("Disconnect") },
    "/api/v1/calendar/google/connect": { post: op("Start Google OAuth; returns the consent URL") },
    "/api/v1/calendar/connections": { get: op("All calendar providers with status, last error and which one the AI uses; the Calendly item also carries redirectUri, redirectSource, redirectWarning, redirectError") },
    "/api/v1/calendar/default": { post: op("Choose the calendar provider the AI books on", { requestBody: body(setDefaultCalendarSchema) }) },
    "/api/v1/calendar/calendly/connect": { post: op("Start Calendly OAuth (PKCE); returns the consent URL, the redirectUri and an optional warning. 400 when the redirect URI would be rejected by Calendly (not https, or localhost in production)", { responses: { 200: out("Consent URL"), ...E, 400: err("Invalid redirect URI") } }) },
    "/api/v1/calendar/calendly/callback": { get: { summary: "Calendly OAuth redirect target (signed state)", tags: ["ops"], responses: { 302: out("Redirect to the dashboard") } } },
    "/api/v1/calendar/calendly/event-types": { get: op("Active Calendly event types of the connected account") },
    "/api/v1/calendar/calendly/event-type": { patch: op("Choose the Calendly event type used for availability and booking", { requestBody: body(setCalendlyEventTypeSchema) }) },
    "/api/v1/calendar/calendly/connection": { delete: op("Disconnect Calendly (revokes and deletes the tokens)") },
    "/api/v1/crm/hubspot": { get: op("HubSpot connection status, mapping and the last 10 syncs (the token is never returned)") },
    "/api/v1/crm/hubspot/connection": {
      put: op("Connect HubSpot with a private-app access token (tested live, stored encrypted, write-only)", { requestBody: body(connectHubspotSchema) }),
      delete: op("Disconnect HubSpot (deletes the stored token)"),
    },
    "/api/v1/crm/hubspot/mapping": { patch: op("Update the property mapping", { requestBody: body(updateHubspotMappingSchema) }) },
    "/api/v1/crm/hubspot/test-contact": { post: op("Upsert one test contact in HubSpot with the saved mapping", { requestBody: body(hubspotTestContactSchema) }) },
    "/api/v1/calendar/google/callback": { get: { summary: "Google OAuth redirect target (signed state)", tags: ["ops"], responses: { 302: out("Redirect to the dashboard") } } },
    "/api/v1/needs-attention": { get: op("Needs Attention queue", { parameters: page }) },
    "/api/v1/needs-attention/counts": { get: op("Unresolved counts per handoff type") },
    "/api/v1/needs-attention/{id}": { get: op("Handoff detail", { parameters: [id] }) },
    "/api/v1/needs-attention/{id}/claim": { post: op("Claim = takeover", { parameters: [id], requestBody: body(claimHandoffSchema), responses: { 200: out("OK"), 409: err("Claimed by someone else"), ...E } }) },
    "/api/v1/needs-attention/{id}/assign": { post: op("Assign to a teammate (admin)", { parameters: [id], requestBody: body(assignHandoffSchema) }) },
    "/api/v1/needs-attention/{id}/release": { post: op("Release a claimed handoff", { parameters: [id] }) },
    "/api/v1/needs-attention/{id}/resolve": { post: op("Resolve (optionally return to AI)", { parameters: [id], requestBody: body(resolveHandoffSchema) }) },
    "/api/v1/availability": { get: op("Team availability") },
    "/api/v1/availability/me": { put: op("Set my availability", { requestBody: body(setAvailabilitySchema) }) },
    "/api/v1/ops/settings": { get: op("SLA, business hours, out-of-hours and routing settings"), put: op("Update settings (admin)", { requestBody: body(opsSettingsUpdateSchema) }) },
    "/api/v1/business-hours/status": { get: op("Is the business open now?") },
    ...crud("canned-responses", "canned responses", createCannedSchema, updateCannedSchema, false),
    "/api/v1/tags": { get: op("List tags with counts"), post: op("Create tag", { requestBody: body(createTagSchema), responses: { 201: out("Created"), ...E } }) },
    "/api/v1/tags/{id}": { patch: op("Update tag", { parameters: [id], requestBody: body(updateTagSchema) }), delete: op("Delete tag", { parameters: [id] }) },
    "/api/v1/tags/{id}/resources": { get: op("Resources carrying a tag", { parameters: [id, ...page] }) },
    "/api/v1/{resource}/{id}/tags": {
      get: op("Tags of a conversation/contact/ticket", { parameters: [{ name: "resource", in: "path", required: true, schema: { type: "string", enum: ["conversations", "contacts", "tickets"] } }, id] }),
      put: op("Replace tags of a conversation/contact/ticket", { parameters: [{ name: "resource", in: "path", required: true, schema: { type: "string", enum: ["conversations", "contacts", "tickets"] } }, id], requestBody: body(setTagsSchema) }),
    },
    "/api/v1/notifications": { get: op("My notifications", { parameters: page }) },
    "/api/v1/notifications/read-all": { post: op("Mark all read") },
    "/api/v1/notifications/{id}/read": { post: op("Mark one read", { parameters: [id] }) },
    "/api/v1/notifications/preferences": { get: op("Email preference"), put: op("Set email preference", { requestBody: body(notificationPrefsSchema) }) },
  };
}
