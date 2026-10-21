import { z } from "zod";
import { errorEnvelopeSchema } from "@yulona/shared";
import { createAgentSchema, createSessionSchema, sessionMessageSchema } from "./schemas";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const E = { 400: err("Validation error"), 401: err("Unauthorized"), 403: err("Requires owner/admin"), 404: err("Not found") };
const op = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, tags: ["Agent builder"], security: [{ bearerAuth: [] }], responses: { 200: { description: "OK" }, ...E }, ...extra });

/** Agent builder chat (see docs/api/agent-builder.md). */
export function agentBuilderPaths(): Record<string, unknown> {
  return {
    "/api/v1/agent-builder/sessions": {
      post: op("Start a builder session (owner/admin, 10/min). Returns the session with the assistant's opening question", { requestBody: body(createSessionSchema), responses: { 201: { description: "Created" }, 429: err("Rate limited"), ...E } }),
    },
    "/api/v1/agent-builder/sessions/{id}": {
      get: op("Get one of your own sessions: messages (user/assistant/tool) and the live draft", { parameters: [id] }),
    },
    "/api/v1/agent-builder/sessions/{id}/messages": {
      post: op("Send a free-text answer or a quick-reply choice; the assistant replies (20/min). 402 credits_exhausted in SaaS when credits are used up", { parameters: [id], requestBody: body(sessionMessageSchema), responses: { 200: { description: "New messages, assistant reply, draft, ready" }, 402: err("credits_exhausted"), 409: err("Session closed or busy"), 429: err("Rate limited or session cap"), 503: err("AI provider unavailable"), ...E } }),
    },
    "/api/v1/agent-builder/sessions/{id}/create": {
      post: op("Create the DRAFT agent from the session draft (never publishes; same limit and audit path as POST /agents; created_via=builder)", { parameters: [id], requestBody: body(createAgentSchema), responses: { 201: { description: "Created: agentId and sandboxHint" }, 402: err("Plan limit reached"), 409: err("Session already used"), ...E } }),
    },
  };
}
