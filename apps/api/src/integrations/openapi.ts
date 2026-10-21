import { z } from "zod";
import { cancelBookingSchema, createBookingSchema, contactSchema, conversationSummarySchema, createContactSchema, errorEnvelopeSchema, messageDtoSchema, okSchema, pageSchema, updateContactSchema } from "@yulona/shared";
import { createWebhookDeliverySchemas } from "./openapi-schemas";
import { createWebhookSchema, patchWebhookSchema } from "./webhooks";
import { erasureRequestSchema, exportRequestSchema } from "./gdpr";
import { putRetentionSchema } from "./retention";
import { createConversationSchema, sendMessageSchema } from "./public-api";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const resp = (description: string, s?: z.ZodType) => ({ description, ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}) });
const err = (d: string) => resp(d, errorEnvelopeSchema);
const uuidParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
const q = (name: string, schema: Record<string, unknown>, description?: string) => ({ name, in: "query", required: false, schema, ...(description ? { description } : {}) });
const limit = q("limit", { type: "integer", minimum: 1, maximum: 100, default: 30 });
const cursor = q("cursor", { type: "string" }, "Opaque cursor from the previous page's nextCursor");
const jwt = [{ bearerAuth: [] }];
const key = [{ apiKeyAuth: [] }];
const std = { 400: err("Validation error"), 401: err("Unauthorized"), 403: err("Insufficient role or scope"), 404: err("Not found"), 429: err("Rate limited") };

const D = createWebhookDeliverySchemas();

/** OpenAPI paths for outbound webhooks, GDPR, retention and the API-key public API. */
export function integrationsPaths(): Record<string, unknown> {
  const W = "Webhooks", G = "GDPR", R = "Retention", P = "Public API";
  const dash = (tag: string, summary: string, extra: Record<string, unknown>) => ({ summary: `${summary} (min role: admin)`, tags: [tag], security: jwt, ...extra });
  const pub = (summary: string, scope: string, extra: Record<string, unknown>) => ({ summary: `${summary} (scope: ${scope})`, tags: [P], security: key, ...extra });
  const pagedContacts = pageSchema(contactSchema);
  const P1 = "/api/v1/public-api";
  return {
    "/api/v1/webhooks/events": { get: dash(W, "Subscribable event types", { responses: { 200: resp("Event types", z.object({ events: z.array(z.string()) })), ...std } }) },
    "/api/v1/webhooks": {
      get: dash(W, "List webhooks", { responses: { 200: resp("Webhooks", z.object({ items: z.array(D.webhook) })), ...std } }),
      post: dash(W, "Create a webhook; the signing secret is returned once", { requestBody: body(createWebhookSchema), responses: { 201: resp("Webhook with `secret`", D.webhookWithSecret), 409: err("Webhook limit reached"), 503: err("ENCRYPTION_KEY not configured"), ...std } }),
    },
    "/api/v1/webhooks/{id}": {
      get: dash(W, "Get webhook", { parameters: [uuidParam()], responses: { 200: resp("Webhook", D.webhook), ...std } }),
      patch: dash(W, "Update webhook (re-enabling resets the failure counter)", { parameters: [uuidParam()], requestBody: body(patchWebhookSchema), responses: { 200: resp("Webhook", D.webhook), ...std } }),
      delete: dash(W, "Delete webhook and its delivery log", { parameters: [uuidParam()], responses: { 200: resp("OK", okSchema), ...std } }),
    },
    "/api/v1/webhooks/{id}/rotate-secret": { post: dash(W, "Rotate the signing secret; the new secret is returned once", { parameters: [uuidParam()], responses: { 200: resp("New secret", z.object({ id: z.uuid(), secret: z.string() })), ...std } }) },
    "/api/v1/webhooks/{id}/test": { post: dash(W, "Queue a signed `webhook.test` event", { parameters: [uuidParam()], responses: { 202: resp("Queued", z.object({ deliveryId: z.uuid() })), ...std } }) },
    "/api/v1/webhooks/{id}/deliveries": {
      get: dash(W, "Delivery log (newest first)", { parameters: [uuidParam(), q("status", { type: "string", enum: ["pending", "retrying", "succeeded", "failed", "cancelled"] }), limit, cursor], responses: { 200: resp("Deliveries", pageSchema(D.delivery)), ...std } }),
    },
    "/api/v1/webhook-deliveries/{id}": { get: dash(W, "Delivery detail with payload and per-attempt log", { parameters: [uuidParam()], responses: { 200: resp("Delivery", D.deliveryDetail), ...std } }) },
    "/api/v1/webhook-deliveries/{id}/redeliver": { post: dash(W, "Redeliver (same event id and payload, new delivery)", { parameters: [uuidParam()], responses: { 202: resp("Queued", z.object({ deliveryId: z.uuid() })), 409: err("Webhook disabled"), ...std } }) },

    "/api/v1/gdpr/exports": { post: dash(G, "Request a data export of one contact, or the whole workspace when contactId is omitted (async)", { requestBody: body(exportRequestSchema), responses: { 202: resp("Request", D.gdprRequest), 409: err("Too many requests in progress"), ...std } }) },
    "/api/v1/gdpr/erasures": { post: dash(G, "Request erasure (anonymisation) of a contact's personal data (async, irreversible)", { requestBody: body(erasureRequestSchema), responses: { 202: resp("Request", D.gdprRequest), 409: err("Too many requests in progress"), ...std } }) },
    "/api/v1/gdpr/requests": { get: dash(G, "List GDPR requests", { parameters: [q("kind", { type: "string", enum: ["export", "erasure"] }), limit, cursor], responses: { 200: resp("Requests", pageSchema(D.gdprRequest)), ...std } }) },
    "/api/v1/gdpr/requests/{id}": { get: dash(G, "GDPR request status", { parameters: [uuidParam()], responses: { 200: resp("Request", D.gdprRequest), ...std } }) },
    "/api/v1/gdpr/requests/{id}/download": {
      get: dash(G, "Download a completed export: JSON `{url, expiresAt}` (signed, 15 min) when the storage backend presigns, otherwise the JSON file itself", {
        parameters: [uuidParam()], responses: { 200: resp("Signed URL or file", z.object({ url: z.string(), expiresAt: z.string() })), ...std } }),
    },

    "/api/v1/retention": {
      get: dash(R, "Retention policy", { responses: { 200: resp("Policy", D.retention), ...std } }),
      put: dash(R, "Replace retention policy (null = keep)", { requestBody: body(putRetentionSchema), responses: { 200: resp("Policy", D.retention), ...std } }),
    },

    [`${P1}/contacts`]: {
      get: pub("List contacts", "contacts:read", { parameters: [q("q", { type: "string" }), limit, cursor], responses: { 200: resp("Contacts", pagedContacts), ...std } }),
      post: pub("Create contact", "contacts:write", { requestBody: body(createContactSchema), responses: { 201: resp("Contact", contactSchema), ...std } }),
    },
    [`${P1}/contacts/{id}`]: {
      get: pub("Get contact", "contacts:read", { parameters: [uuidParam()], responses: { 200: resp("Contact", contactSchema), ...std } }),
      patch: pub("Update contact (customAttributes keys set to null are removed)", "contacts:write", { parameters: [uuidParam()], requestBody: body(updateContactSchema), responses: { 200: resp("Contact", contactSchema), ...std } }),
    },
    [`${P1}/conversations`]: {
      get: pub("List conversations", "conversations:read", { parameters: [q("status", { type: "string", enum: ["open", "pending_human", "resolved"] }), q("handler", { type: "string", enum: ["ai", "human"] }), q("contactId", { type: "string", format: "uuid" }), limit, cursor], responses: { 200: resp("Conversations", pageSchema(conversationSummarySchema)), ...std } }),
      post: pub("Start a conversation for a contact", "conversations:write", { requestBody: body(createConversationSchema), responses: { 201: resp("Conversation", conversationSummarySchema), 402: err("Plan limit reached"), ...std } }),
    },
    [`${P1}/conversations/{id}`]: { get: pub("Get conversation", "conversations:read", { parameters: [uuidParam()], responses: { 200: resp("Conversation", conversationSummarySchema), ...std } }) },
    [`${P1}/conversations/{id}/messages`]: {
      get: pub("Customer-visible messages, oldest first within the page", "conversations:read", { parameters: [uuidParam(), q("before", { type: "string", format: "uuid" }, "Return messages older than this id"), q("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 })], responses: { 200: resp("Messages", z.object({ items: z.array(messageDtoSchema), nextCursor: z.string().nullable() })), ...std } }),
      post: pub("Send a message (idempotent by clientMessageId). sender=contact triggers the AI reply", "conversations:write", { parameters: [uuidParam()], requestBody: body(sendMessageSchema), responses: { 201: resp("Created", messageDtoSchema), 200: resp("Replay of an existing clientMessageId", messageDtoSchema), ...std } }),
    },
    [`${P1}/bookings`]: { get: pub("List bookings", "bookings:read", { parameters: [q("status", { type: "string", enum: ["booked", "cancelled", "failed"] }), q("contactId", { type: "string", format: "uuid" }), q("conversationId", { type: "string", format: "uuid" }), q("from", { type: "string", format: "date-time" }), q("to", { type: "string", format: "date-time" }), limit, cursor], responses: { 200: resp("Bookings", pageSchema(D.booking)), ...std } }),
      post: pub("Create a booking; uses the tenant's Google Calendar when connected, otherwise stores a manual booking", "bookings:write", { requestBody: body(createBookingSchema), responses: { 201: resp("Booking", D.booking), 409: err("Overlaps an existing booking"), 503: err("Calendar unavailable"), ...std } }) },
    [`${P1}/bookings/{id}`]: { get: pub("Get booking", "bookings:read", { parameters: [uuidParam()], responses: { 200: resp("Booking", D.booking), ...std } }) },
    [`${P1}/bookings/{id}/cancel`]: { post: pub("Cancel a booking (also cancels the external calendar event)", "bookings:write", { parameters: [uuidParam()], requestBody: body(cancelBookingSchema), responses: { 200: resp("Booking", D.booking), 409: err("Already cancelled"), 503: err("Calendar unavailable"), ...std } }) },
  };
}

