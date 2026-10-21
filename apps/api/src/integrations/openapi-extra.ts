import { z } from "zod";
import { errorEnvelopeSchema } from "@yulona/shared";
import { chunksQuery, createTextSourceSchema, createUrlSourceSchema, listSourcesQuery, sandboxSchema, updateSourceSchema } from "../routes/knowledge";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const ok = (d: string, s?: z.ZodType) => ({ description: d, ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}) });
const jwt = [{ bearerAuth: [] }];
const std = { 400: err("Validation error"), 401: err("Unauthorized"), 404: err("Not found") };
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const asQuery = (s: z.ZodType) => {
  const sch = j(s, "input") as { properties?: Record<string, Record<string, unknown>> };
  return Object.entries(sch.properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: false, schema }));
};

const source = z.object({
  id: z.uuid(), agentId: z.uuid().nullable(), type: z.enum(["file", "url", "text"]), name: z.string(), skill: z.string(), description: z.string().nullable(), status: z.enum(["pending", "processing", "ready", "failed"]),
  error: z.string().nullable(), sourceUrl: z.string().nullable(), fileName: z.string().nullable(), sizeBytes: z.number(), chunkCount: z.number().int(),
  attempts: z.number().int(), maxPages: z.number().int().optional(), lastIngestedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});

/** Knowledge + sandbox endpoints (owned by ai-runtime) were missing from the spec; documented here. */
export function knowledgePaths(): Record<string, unknown> {
  const K = "Knowledge";
  const op = (summary: string, extra: Record<string, unknown>) => ({ summary, tags: [K], security: jwt, ...extra });
  return {
    "/api/v1/knowledge/sources": { get: op("List knowledge sources", { parameters: asQuery(listSourcesQuery), responses: { 200: ok("Sources", z.object({ items: z.array(source), limit: z.number(), offset: z.number() })), ...std } }) },
    "/api/v1/knowledge/sources/{id}": {
      get: op("Get a source", { parameters: [id], responses: { 200: ok("Source", source), ...std } }),
      patch: op("Rename a skill / set the one-line description the agent sees in its skill index (owner/admin)", { parameters: [id], requestBody: body(updateSourceSchema), responses: { 200: ok("Source", source), ...std } }),
      delete: op("Delete a source and its sections (agent+)", { parameters: [id], responses: { 200: ok("OK"), ...std } }),
    },
    "/api/v1/knowledge/sources/{id}/chunks": { get: op("Chunk viewer", { parameters: [id, ...asQuery(chunksQuery)], responses: { 200: ok("Chunks"), ...std } }) },
    "/api/v1/knowledge/sources/text": { post: op("Add a text source (agent+)", { requestBody: body(createTextSourceSchema), responses: { 201: ok("Source", source), 402: err("Plan limit"), ...std } }) },
    "/api/v1/knowledge/sources/url": { post: op("Add a URL source; crawled by the worker, SSRF-safe (agent+)", { requestBody: body(createUrlSourceSchema), responses: { 201: ok("Source", source), 402: err("Plan limit"), ...std } }) },
    "/api/v1/knowledge/sources/file": {
      post: op("Upload a PDF/DOCX/TXT/HTML file, max 10 MB (agent+)", {
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, agentId: { type: "string", format: "uuid" } } } } } },
        responses: { 201: ok("Source", source), 402: err("Plan limit"), 413: err("File too large"), ...std } }),
    },
    "/api/v1/knowledge/sources/{id}/reingest": { post: op("Re-run ingestion (agent+)", { parameters: [id], responses: { 200: ok("Source", source), ...std } }) },
    "/api/v1/knowledge/sandbox": { post: op("Sandbox test console: answer + retrieved chunks, scores, stage, handoff", { requestBody: body(sandboxSchema), responses: { 200: ok("Sandbox result"), 429: err("Rate limited"), ...std } }) },
    "/api/v1/auth/csrf": { get: { summary: "Issue/refresh the CSRF double-submit token (cookie yl_csrf + X-CSRF-Token response header)", tags: ["Auth"], responses: { 200: ok("Token issued") } } },
    "/api/v1/realtime/ws": {
      get: { summary: "WebSocket upgrade. Send {type:'auth', token} as the first frame (never in the URL). See docs/api/conversations.md", tags: ["Realtime"], responses: { 101: { description: "Switching Protocols" }, 426: { description: "Upgrade required" } } },
    },
  };
}

type Op = Record<string, unknown> & { parameters?: Record<string, unknown>[]; tags?: string[]; operationId?: string; responses?: Record<string, unknown> };
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

/**
 * Makes the generated document import cleanly into Postman / codegen tools: unique operationIds, tags,
 * declared path parameters, a `servers` entry, an apiKey scheme, and a non-empty responses object.
 */
/** OpenAPI 3.0 (JSON Schema draft 4) forbids an empty `required` array: strip them wherever a schema generator emitted one. */
function dropEmptyRequired(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(dropEmptyRequired);
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.required) && o.required.length === 0) delete o.required;
  for (const v of Object.values(o)) dropEmptyRequired(v);
}

export function polishOpenApi<T extends { paths: Record<string, Record<string, unknown>>; info?: Record<string, unknown>; components?: Record<string, unknown> }>(doc: T, serverUrl = "/"): T {
  const used = new Set<string>();
  const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
  for (const [path, item] of Object.entries(doc.paths)) {
    const segs = path.split("/").filter(Boolean).filter((s, i) => !(i < 2 && (s === "api" || s === "v1")));
    for (const m of METHODS) {
      const op = item[m] as Op | undefined;
      if (!op) continue;
      if (!op.operationId) {
        const base = m + segs.map((s) => (s.startsWith("{") ? `By${camel(s.slice(1, -1)).replace(/^./, (c) => c.toUpperCase())}` : camel(s).replace(/^./, (c) => c.toUpperCase()))).join("");
        let name = base;
        for (let i = 2; used.has(name); i++) name = `${base}${i}`;
        used.add(name);
        op.operationId = name;
      } else used.add(op.operationId);
      if (!op.tags?.length) op.tags = [segs[0] ?? "default"];
      if (!op.responses || Object.keys(op.responses).length === 0) op.responses = { 200: { description: "OK" } };
      const declared = new Set((op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name));
      for (const [, pn] of path.matchAll(/\{([^}]+)\}/g)) {
        if (!declared.has(pn)) (op.parameters ??= []).push({ name: pn!, in: "path", required: true, schema: { type: "string" } });
      }
    }
  }
  dropEmptyRequired(doc.paths);
  const info = { ...(doc.info ?? {}) };
  info.description ??= "Yulona API. Dashboard endpoints use a user JWT (bearerAuth); `/api/v1/public-api/*` uses a tenant API key (apiKeyAuth); `/api/v1/public/widget/*` uses a widget session. Webhook deliveries are signed: see docs/api/integrations.md.";
  const components = { ...(doc.components ?? {}) } as { securitySchemes?: Record<string, unknown> };
  components.securitySchemes = { apiKeyAuth: { type: "http", scheme: "bearer", bearerFormat: "yl_<prefix>_<secret>" }, ...(components.securitySchemes ?? {}) };
  return { ...doc, info, components, servers: [{ url: serverUrl }] } as T;
}
