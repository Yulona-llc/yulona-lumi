import { z } from "zod";

/** v1 manifests (`endpointTemplate` + inline secret) keep working unchanged; v2 adds connections + a request builder. */
export const TOOL_MANIFEST_VERSION = 1 as const;
export const TOOL_MANIFEST_VERSION_V2 = 2 as const;

const stages = z.enum(["visitor", "engaged", "qualified", "booking_offered", "booked", "handoff_requested"]);
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Headers a tool may never set itself (auth is applied from the connection; hop-by-hop/host are controlled). */
export const RESERVED_TOOL_HEADERS = ["authorization", "proxy-authorization", "cookie", "host", "content-length", "connection", "transfer-encoding", "x-yulona-signature", "x-yulona-timestamp", "x-lumi-signature", "x-lumi-timestamp"];
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export const toolRequestFieldSchema = z.strictObject({
  /** key in the tool's input (the model fills it) */
  name: z.string().regex(FIELD_NAME),
  in: z.enum(["path", "query", "body", "header"]),
  /** header name or query/body key when it differs from `name` */
  as: z.string().min(1).max(64).optional(),
});

export const toolRequestSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** relative to the connection's base URL, e.g. `/orders/{{orderId}}`; must start with `/` */
  path: z.string().min(1).max(2048).regex(/^\/(?!\/)/, "path must start with a single /"),
  fields: z.array(toolRequestFieldSchema).max(50).default([]),
  /** static extra headers (values may reference `{{field}}`) */
  headers: z.record(z.string().regex(HEADER_NAME), z.string().max(1000)).optional(),
  /** JSON template for the body; strings equal to `{{field}}` keep the field's type */
  bodyTemplate: z.string().max(8000).optional(),
});

const base = {
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  description: z.string().min(1).max(1000),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  authType: z.enum(["none", "api_key", "bearer", "oauth2"]).default("none"),
  /** Stages in which the tool may be offered to the model. */
  allowedStages: z.array(stages).optional(),
};

export const toolManifestV1Schema = z.strictObject({
  version: z.literal(1),
  ...base,
  authType: z.enum(["none", "api_key", "bearer", "oauth2"]),
  endpointTemplate: z.string().max(2048).optional(),
  responseMapping: z.record(z.string(), z.string()).optional(),
});

export const toolManifestV2Schema = z.strictObject({
  version: z.literal(2),
  ...base,
  connectionId: z.uuid(),
  request: toolRequestSchema,
  timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  /** idempotent methods only (GET, PUT, DELETE) */
  retry: z.strictObject({ attempts: z.number().int().min(2).max(4), baseMs: z.number().int().min(50).max(5000).default(300) }).optional(),
  /** `a.b`, `a[0].b`, `items[].name` (array of names). Output key -> path into the JSON response. */
  responseMapping: z.record(z.string().regex(FIELD_NAME), z.string().min(1).max(300)).optional(),
  /** handoff: raise a system_failure handoff (default). tell_customer: the model is told and informs the customer. */
  onFailure: z.enum(["handoff", "tell_customer"]).default("handoff"),
  /** the first call only asks the model to confirm with the customer; a second call with `confirmed: true` runs it */
  confirmBeforeRun: z.boolean().default(false),
}).superRefine((m, ctx) => {
  const r = m.request;
  if (m.retry && !["GET", "PUT", "DELETE"].includes(r.method)) ctx.addIssue({ code: "custom", path: ["retry"], message: "retry is only allowed for idempotent methods (GET, PUT, DELETE)" });
  const names = new Set<string>();
  for (const [i, f] of r.fields.entries()) {
    if (names.has(`${f.in}:${f.name}`)) ctx.addIssue({ code: "custom", path: ["request", "fields", i], message: "duplicate field" });
    names.add(`${f.in}:${f.name}`);
    if (f.in === "header") {
      const h = (f.as ?? f.name).toLowerCase();
      if (!HEADER_NAME.test(h) || RESERVED_TOOL_HEADERS.includes(h)) ctx.addIssue({ code: "custom", path: ["request", "fields", i], message: "header not allowed" });
    }
  }
  for (const h of Object.keys(r.headers ?? {})) if (RESERVED_TOOL_HEADERS.includes(h.toLowerCase())) ctx.addIssue({ code: "custom", path: ["request", "headers", h], message: "header not allowed" });
  const pathVars = [...r.path.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((x) => x[1]!);
  for (const v of pathVars) if (!r.fields.some((f) => f.in === "path" && f.name === v)) ctx.addIssue({ code: "custom", path: ["request", "path"], message: `path placeholder {{${v}}} needs a field with in: "path"` });
  for (const [i, f] of r.fields.entries()) if (f.in === "path" && !pathVars.includes(f.name)) ctx.addIssue({ code: "custom", path: ["request", "fields", i], message: "path field is not used in the path" });
  if (r.bodyTemplate !== undefined) {
    if (r.method === "GET" || r.method === "DELETE") ctx.addIssue({ code: "custom", path: ["request", "bodyTemplate"], message: "GET/DELETE cannot have a body" });
    try { JSON.parse(r.bodyTemplate.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "x")); } catch { ctx.addIssue({ code: "custom", path: ["request", "bodyTemplate"], message: "bodyTemplate must be valid JSON; placeholders go inside strings, e.g. {\"id\": \"{{orderId}}\"}" }); }
  }
});

export const toolManifestSchema = z.discriminatedUnion("version", [toolManifestV1Schema, toolManifestV2Schema]);
export type ToolManifestV1 = z.infer<typeof toolManifestV1Schema>;
export type ToolManifestV2 = z.infer<typeof toolManifestV2Schema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type ToolRequest = z.infer<typeof toolRequestSchema>;

export const toolConnectionAuthTypes = ["none", "bearer", "api_key", "basic", "hmac"] as const;
