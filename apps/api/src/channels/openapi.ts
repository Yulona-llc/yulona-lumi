import { z } from "zod";
import { errorEnvelopeSchema, okSchema } from "@yulona/shared";
import {
  channelInfoSchema, connectionSchema, createConnectionResponseSchema, createConnectionSchema, healthResultSchema,
  mergeSuggestionSchema, updateConnectionSchema,
} from "./schemas";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const resp = (description: string, s?: z.ZodType) => ({ description, ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}) });
const err = (d: string) => resp(d, errorEnvelopeSchema);
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const sec = [{ bearerAuth: [] }];
const e = { 400: err("Validation error"), 401: err("Unauthorized"), 403: err("Forbidden"), 404: err("Not found") };
const hook = [
  { name: "channel", in: "path", required: true, schema: { type: "string", enum: ["whatsapp", "facebook", "instagram", "telegram", "slack"] } },
  { name: "connectionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
];

/** OpenAPI path items for the channels area (merged into the main document). */
export function channelPaths(): Record<string, unknown> {
  const dash = (summary: string, extra: Record<string, unknown>) => ({ summary, security: sec, tags: ["channels"], ...extra });
  return {
    "/api/v1/channels/available": { get: dash("Connectable channels: capabilities and credential fields", { responses: { 200: resp("Channels", z.object({ items: z.array(channelInfoSchema) })), ...e } }) },
    "/api/v1/channels/connections": {
      get: dash("List channel connections (credentials masked)", { responses: { 200: resp("Connections", z.object({ items: z.array(connectionSchema) })), ...e } }),
      post: dash("Create a connection (owner/admin). Webhook secrets left empty are generated and returned once", { requestBody: body(createConnectionSchema), responses: { 201: resp("Connection", createConnectionResponseSchema), 503: err("ENCRYPTION_KEY not configured"), ...e } }),
    },
    "/api/v1/channels/connections/{id}": {
      get: dash("Connection", { parameters: [idParam], responses: { 200: resp("Connection", connectionSchema), ...e } }),
      patch: dash("Update name/agent/status or rotate credentials (owner/admin)", { parameters: [idParam], requestBody: body(updateConnectionSchema), responses: { 200: resp("Connection", connectionSchema), ...e } }),
      delete: dash("Delete a connection (owner/admin); conversations keep their history but can no longer send", { parameters: [idParam], responses: { 200: resp("OK", okSchema), ...e } }),
    },
    "/api/v1/channels/connections/{id}/test": { post: dash("Health check with the stored credentials (owner/admin)", { parameters: [idParam], responses: { 200: resp("Result", healthResultSchema), 429: err("Rate limited"), ...e } }) },
    "/api/v1/channels/merge-suggestions": { get: dash("Pending cross-channel contact merge suggestions", { responses: { 200: resp("Suggestions", z.object({ items: z.array(mergeSuggestionSchema) })), ...e } }) },
    "/api/v1/channels/merge-suggestions/{id}/dismiss": { post: dash("Dismiss a suggestion", { parameters: [idParam], responses: { 200: resp("OK", okSchema), ...e } }) },
    "/api/v1/webhooks/channels/{channel}/{connectionId}": {
      get: { summary: "Provider handshake (Meta hub.challenge). Public", tags: ["channels"], parameters: hook, responses: { 200: resp("Challenge echoed"), 403: err("Bad verify token"), 404: err("Unknown connection") } },
      post: { summary: "Inbound events. Public; authenticated by provider signature over the raw body", tags: ["channels"], parameters: hook, responses: { 200: resp("Accepted (also for duplicates)"), 401: err("Invalid signature"), 404: err("Unknown/disabled connection"), 429: err("Rate limited") } },
    },
  };
}
