import { z } from "zod";
import {
  contactSchema, conversationSummarySchema, createContactSchema, createWidgetSchema, errorEnvelopeSchema, mergeContactSchema,
  messageDtoSchema, pageSchema, patchConversationSchema, publicMessageSchema, publicSendMessageSchema, sendMessageSchema,
  startConversationSchema, typingSchema, uiEventSchema, updateContactSchema, updateWidgetSchema, widgetSchema, okSchema,
} from "@yulona/shared";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const resp = (description: string, s?: z.ZodType) => ({ description, ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}) });
const err = (d: string) => resp(d, errorEnvelopeSchema);
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const sec = [{ bearerAuth: [] }];
const widgetKey = { name: "X-Widget-Key", in: "header", required: true, schema: { type: "string" } };
const session = [{ widgetSession: [] }];
const e = { 400: err("Validation error"), 401: err("Unauthorized"), 404: err("Not found") };

/** OpenAPI path items for the conversations area (merged into the main document). */
export function conversationPaths(): Record<string, unknown> {
  const dash = (summary: string, extra: Record<string, unknown>) => ({ summary, security: sec, ...extra });
  const pubOp = (summary: string, extra: Record<string, unknown>, needsSession = true) => ({
    summary, parameters: [widgetKey], ...(needsSession ? { security: session } : {}), ...extra,
  });
  const P = "/api/v1/public/widget";
  return {
    "/api/v1/conversations": { get: dash("List conversations (filters, search, cursor)", { responses: { 200: resp("Page", pageSchema(conversationSummarySchema)), ...e } }) },
    "/api/v1/conversations/{id}": {
      get: dash("Conversation detail", { parameters: [idParam], responses: { 200: resp("Conversation", conversationSummarySchema), ...e } }),
      patch: dash("Resolve/reopen/assign", { parameters: [idParam], requestBody: body(patchConversationSchema), responses: { 200: resp("Conversation", conversationSummarySchema), ...e } }),
    },
    "/api/v1/conversations/{id}/messages": {
      get: dash("Messages (incl. internal notes)", { parameters: [idParam], responses: { 200: resp("Page", pageSchema(messageDtoSchema)), ...e } }),
      post: dash("Send reply (implies takeover) or internal note", { parameters: [idParam], requestBody: body(sendMessageSchema), responses: { 201: resp("Message", messageDtoSchema), ...e } }),
    },
    "/api/v1/conversations/{id}/ai-state": { get: dash("AI state: stage, lead card, active handoff", { parameters: [idParam], responses: { 200: resp("AI state"), ...e } }) },
    "/api/v1/conversations/{id}/takeover": { post: dash("Human takeover", { parameters: [idParam], responses: { 200: resp("Conversation", conversationSummarySchema), 409: err("Assigned to another agent"), ...e } }) },
    "/api/v1/conversations/{id}/return-to-ai": { post: dash("Return conversation to the AI", { parameters: [idParam], responses: { 200: resp("Conversation", conversationSummarySchema), ...e } }) },
    "/api/v1/contacts": {
      get: dash("List contacts", { responses: { 200: resp("Page", pageSchema(contactSchema)), ...e } }),
      post: dash("Create contact", { requestBody: body(createContactSchema), responses: { 201: resp("Contact", contactSchema), ...e } }),
    },
    "/api/v1/contacts/{id}": {
      get: dash("Contact", { parameters: [idParam], responses: { 200: resp("Contact", contactSchema), ...e } }),
      patch: dash("Update contact / custom attributes", { parameters: [idParam], requestBody: body(updateContactSchema), responses: { 200: resp("Contact", contactSchema), ...e } }),
      delete: dash("Delete contact without conversations", { parameters: [idParam], responses: { 200: resp("OK", okSchema), 409: err("Has conversations"), ...e } }),
    },
    "/api/v1/contacts/{id}/timeline": { get: dash("Cross-channel timeline", { parameters: [idParam], responses: { 200: resp("Page"), ...e } }) },
    "/api/v1/contacts/{id}/merge": { post: dash("Merge another contact into this one", { parameters: [idParam], requestBody: body(mergeContactSchema), responses: { 200: resp("Contact", contactSchema), 409: err("Already merged"), ...e } }) },
    "/api/v1/widgets": {
      get: dash("List widgets", { responses: { 200: resp("Widgets", z.object({ items: z.array(widgetSchema) })), ...e } }),
      post: dash("Create widget (owner/admin)", { requestBody: body(createWidgetSchema), responses: { 201: resp("Widget", widgetSchema), 403: err("Forbidden"), ...e } }),
    },
    "/api/v1/widgets/{id}": {
      get: dash("Widget", { parameters: [idParam], responses: { 200: resp("Widget", widgetSchema), ...e } }),
      patch: dash("Update widget (owner/admin)", { parameters: [idParam], requestBody: body(updateWidgetSchema), responses: { 200: resp("Widget", widgetSchema), ...e } }),
      delete: dash("Delete widget (owner/admin)", { parameters: [idParam], responses: { 200: resp("OK", okSchema), ...e } }),
    },
    "/api/v1/widgets/{id}/rotate-key": { post: dash("Rotate public widget key (owner/admin)", { parameters: [idParam], responses: { 200: resp("Widget", widgetSchema), ...e } }) },
    "/api/v1/widgets/{id}/embed": { get: dash("Embed snippet", { parameters: [idParam], responses: { 200: resp("Snippet"), ...e } }) },
    [`${P}/config`]: { get: pubOp("Public widget config (Origin allowlist enforced)", { responses: { 200: resp("Config"), 403: err("Origin/key rejected") } }, false) },
    [`${P}/conversations`]: { post: pubOp("Start conversation; returns session token", { requestBody: body(startConversationSchema), responses: { 201: resp("Session"), 400: err("Validation"), 403: err("Origin/key rejected"), 429: err("Rate limited") } }, false) },
    [`${P}/session/refresh`]: { post: pubOp("Refresh session token", { responses: { 200: resp("Session"), 401: err("Unauthorized") } }) },
    [`${P}/messages`]: {
      get: pubOp("History", { responses: { 200: resp("Messages", z.object({ items: z.array(publicMessageSchema) })), 401: err("Unauthorized") } }),
      post: pubOp("Send message (idempotent by clientMessageId)", { requestBody: body(publicSendMessageSchema), responses: { 201: resp("Message", publicMessageSchema), 200: resp("Replay", publicMessageSchema), 429: err("Rate limited") } }),
    },
    [`${P}/ui-events`]: { post: pubOp("Form/button/calendar event", { requestBody: body(uiEventSchema), responses: { 201: resp("Message", publicMessageSchema), 400: err("Validation") } }) },
    [`${P}/typing`]: { post: pubOp("Typing indicator", { requestBody: body(typingSchema), responses: { 200: resp("OK", okSchema) } }) },
    [`${P}/stream`]: { get: pubOp("Server-sent events fallback", { responses: { 200: { description: "text/event-stream" } } }) },
  };
}
