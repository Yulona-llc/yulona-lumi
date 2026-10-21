import { z } from "zod";
import { errorEnvelopeSchema } from "@yulona/shared";
import { createConnectionSchema, testConnectionSchema, testToolSchema, updateConnectionSchema } from "./schemas";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const ok = (d: string) => ({ description: d });
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const E = { 400: err("Validation error"), 401: err("Unauthorized"), 403: err("Requires owner/admin"), 404: err("Not found") };
const op = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, tags: ["Tools"], security: [{ bearerAuth: [] }], responses: { 200: ok("OK"), ...E }, ...extra });

/** Tool connections + tool test (see docs/api/tools.md). */
export function toolsPaths(): Record<string, unknown> {
  return {
    "/api/v1/tool-connections": {
      get: op("List tool connections (owner/admin); secrets are never returned, only hasSecret"),
      post: op("Create a connection (owner/admin). The secret is write-only", { requestBody: body(createConnectionSchema), responses: { 201: ok("Created"), 409: err("Name already used"), 503: err("ENCRYPTION_KEY not configured"), ...E } }),
    },
    "/api/v1/tool-connections/{id}": {
      get: op("Get a connection", { parameters: [id] }),
      patch: op("Update a connection; a new secret replaces the stored one", { parameters: [id], requestBody: body(updateConnectionSchema), responses: { 200: ok("OK"), 409: err("Name already used"), 503: err("ENCRYPTION_KEY not configured"), ...E } }),
      delete: op("Delete a connection (409 when a tool still uses it)", { parameters: [id], responses: { 200: ok("OK"), 409: err("In use"), ...E } }),
    },
    "/api/v1/tool-connections/{id}/test": {
      post: op("Call the connection's test path (GET) with its credentials; redacted result (20/min)", { parameters: [id], requestBody: body(testConnectionSchema), responses: { 200: ok("Result"), 429: err("Rate limited"), 503: err("ENCRYPTION_KEY not configured"), ...E } }),
    },
    "/api/v1/agents/{id}/tool-runs": {
      get: op("Recent tool runs of an agent: name, success, error, latencyMs, createdAt only (no inputs/outputs); ?limit= 1-100, default 20 (owner/admin/agent)", { parameters: [id, { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } }] }),
    },
    "/api/v1/tools/test": {
      post: op("Run a manifest v2 for real with sample values; returns status, latency, redacted request, 4 KB response excerpt and a field tree for click-to-map (owner/admin, 20/min)", { requestBody: body(testToolSchema), responses: { 200: ok("Result"), 429: err("Rate limited"), 503: err("ENCRYPTION_KEY not configured"), ...E } }),
    },
  };
}
