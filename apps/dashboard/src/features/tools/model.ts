import { toolManifestV2Schema, type ToolManifest, type ToolManifestV2 } from "@yulona/shared";
import type { AuthType, Connection } from "./api";

export type FieldType = "text" | "number" | "boolean" | "choice" | "date";
export type Place = "path" | "query" | "body";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Stage = "visitor" | "engaged" | "qualified" | "booking_offered" | "booked" | "handoff_requested";

export interface FieldDraft {
  id: string; label: string; type: FieldType; required: boolean; example: string; choices: string;
  name: string; nameEdited: boolean; place: Place; as?: string;
}
export interface MappingDraft { key: string; path: string }
export interface ToolDraft {
  title: string; name: string; nameEdited: boolean; purpose: string; description: string; descriptionEdited: boolean;
  connectionId: string; method: Method; path: string; fields: FieldDraft[]; mapping: MappingDraft[];
  stages: Stage[]; confirmBeforeRun: boolean; onFailure: "handoff" | "tell_customer"; timeoutMs: number;
  /** parts of an existing manifest the builder does not edit but must not lose */
  keep: { headers?: Record<string, string>; bodyTemplate?: string; retry?: { attempts: number; baseMs: number }; outputSchema?: Record<string, unknown> };
}

export const BUILTIN_TOOLS = ["qualify_lead", "collect_contact", "escalate_to_human", "check_availability", "book_appointment"];
export const FIELD_TYPES: Array<[FieldType, string]> = [["text", "Text"], ["number", "Number"], ["boolean", "Yes or no"], ["choice", "Choice"], ["date", "Date"]];
export const PLACES: Record<Place, string> = { path: "In the address", query: "After the ? in the address", body: "In the message body" };
export const STAGE_WORDS: Array<[Stage, string]> = [
  ["visitor", "When someone first arrives"],
  ["engaged", "While chatting"],
  ["qualified", "Once they are qualified"],
  ["booking_offered", "When offering a booking"],
  ["booked", "After they have booked"],
];
export const AUTH_LABEL: Record<AuthType, string> = { none: "No sign-in", bearer: "Bearer token", api_key: "API key in a header", basic: "Username and password", hmac: "Signed requests" };
export const AUTH_HELP: Record<AuthType, string> = {
  none: "Your system accepts requests without a password. Only use this for public information.",
  bearer: "Your system gives you a long token. We send it as \"Authorization: Bearer ...\" on every request.",
  api_key: "Your system gives you a key. We send it in a header you name (often X-API-Key).",
  basic: "A username and password, sent the standard way. Ask your developer for both.",
  hmac: "We sign every request with a shared secret so your system can check it came from Yulona.",
};

let uid = 0;
export const newId = () => `f${Date.now().toString(36)}${(uid++).toString(36)}`;

/** "Order number!" -> "order_number". Letters, digits and underscores; starts with a letter. */
export function snake(s: string, max = 40): string {
  let x = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!x) return "";
  if (!/^[a-z]/.test(x)) x = `field_${x}`;
  return x.slice(0, max).replace(/_+$/, "");
}
export function uniqueName(base: string, taken: Iterable<string>, fallback = "field"): string {
  const set = new Set(taken);
  const b = base || fallback;
  if (!set.has(b)) return b;
  for (let i = 2; i < 100; i++) if (!set.has(`${b.slice(0, 36)}_${i}`)) return `${b.slice(0, 36)}_${i}`;
  return `${b}_${Date.now()}`;
}
export const humanize = (name: string) => { const s = name.replace(/_/g, " ").trim(); return s ? s[0]!.toUpperCase() + s.slice(1) : s; };
export const toolNameFromTitle = (title: string, taken: Iterable<string>) => uniqueName(snake(title, 50) || "my_tool", [...taken, ...BUILTIN_TOOLS], "my_tool");

export const blankField = (over: Partial<FieldDraft> & { label: string }, taken: string[] = [], method: Method = "GET"): FieldDraft => ({
  id: newId(), type: "text", required: true, example: "", choices: "", name: uniqueName(snake(over.label), taken), nameEdited: false,
  place: defaultPlace(method), ...over,
});
export const defaultPlace = (m: Method): Place => (m === "GET" || m === "DELETE" ? "query" : "body");
export const placesFor = (m: Method): Place[] => (m === "GET" || m === "DELETE" ? ["path", "query"] : ["path", "query", "body"]);

// ---------------------------------------------------------------- templates
export interface Template { id: string; title: string; blurb: string; slug: string; purpose: string; method: Method; path: string; fields: Array<Partial<FieldDraft> & { label: string }>; stages: Stage[]; confirmBeforeRun: boolean; onFailure: "handoff" | "tell_customer"; keywords: string[] }
export const TEMPLATES: Template[] = [
  { id: "availability", title: "Check availability on my system", blurb: "Ask your own booking or stock system what is free.", slug: "check_availability_system",
    purpose: "Check what is available in the business's own system for a date. Use it before offering the customer a time or a slot.",
    method: "GET", path: "/availability", fields: [{ label: "Date", type: "date", example: "2026-03-14" }, { label: "Service", required: false, example: "Haircut" }],
    stages: ["engaged", "qualified", "booking_offered"], confirmBeforeRun: false, onFailure: "tell_customer", keywords: ["availab", "free", "slot", "open", "stock", "when can"] },
  { id: "book", title: "Book an appointment on my system", blurb: "Create the booking in your own system once the customer agrees.", slug: "book_appointment_system",
    purpose: "Create an appointment in the business's own system. Only use it after the customer has agreed to a specific date and time.",
    method: "POST", path: "/appointments", fields: [{ label: "Customer name", example: "Sara Bekele" }, { label: "Phone number", example: "+251911000000" }, { label: "Date", type: "date", example: "2026-03-14" }, { label: "Time", example: "14:30" }],
    stages: ["engaged", "qualified", "booking_offered"], confirmBeforeRun: true, onFailure: "handoff", keywords: ["book", "appoint", "schedule", "reserve", "reservation"] },
  { id: "lookup", title: "Look up an order or customer", blurb: "Find an order, account or ticket and read the status back.", slug: "lookup_order",
    purpose: "Look up an order or customer record by its reference and report its current status. Use it when the customer asks where their order is or about their account.",
    method: "GET", path: "/orders/{{order_number}}", fields: [{ label: "Order number", example: "A-1001", place: "path" }],
    stages: ["engaged", "qualified", "booking_offered", "booked"], confirmBeforeRun: false, onFailure: "tell_customer", keywords: ["order", "customer", "lookup", "look up", "track", "status", "invoice", "account", "ticket"] },
  { id: "webhook", title: "Send details to my system (webhook)", blurb: "Pass the customer's details to your CRM or another system.", slug: "send_to_system",
    purpose: "Send the customer's details and request to the business's own system. Use it once the customer has shared what the team needs.",
    method: "POST", path: "/leads", fields: [{ label: "Customer name", example: "Sara Bekele" }, { label: "Message", example: "Wants a quote for 20 chairs" }, { label: "Email", required: false, example: "sara@example.com" }],
    stages: ["engaged", "qualified", "booking_offered"], confirmBeforeRun: false, onFailure: "tell_customer", keywords: ["send", "webhook", "crm", "notify", "forward", "lead", "post", "push", "submit"] },
  { id: "scratch", title: "Start from scratch", blurb: "Build it yourself, step by step.", slug: "my_tool", purpose: "",
    method: "GET", path: "/", fields: [], stages: ["engaged", "qualified", "booking_offered"], confirmBeforeRun: false, onFailure: "handoff", keywords: [] },
];

/** Local, no-LLM keyword match for the "Describe it in a sentence" box. */
export function matchTemplate(sentence: string): Template | null {
  const s = sentence.toLowerCase();
  if (s.trim().length < 3) return null;
  let best: { t: Template; score: number } | null = null;
  for (const t of TEMPLATES) {
    const score = t.keywords.reduce((n, k) => n + (s.includes(k) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

export function draftFromTemplate(t: Template, takenToolNames: string[], connectionId = ""): ToolDraft {
  const fields: FieldDraft[] = [];
  for (const f of t.fields) fields.push(blankField({ place: defaultPlace(t.method), ...f }, fields.map((x) => x.name), t.method));
  let path = t.path;
  for (const f of fields) if (f.place === "path" && !path.includes(`{{${f.name}}}`)) path = path.replace(/\{\{[a-z0-9_]+\}\}/, `{{${f.name}}}`);
  return {
    title: t.id === "scratch" ? "" : t.title, name: t.id === "scratch" ? "" : uniqueName(t.slug, [...takenToolNames, ...BUILTIN_TOOLS]), nameEdited: false, purpose: t.purpose, description: "", descriptionEdited: false,
    connectionId, method: t.method, path, fields, mapping: [], stages: [...t.stages], confirmBeforeRun: t.confirmBeforeRun, onFailure: t.onFailure, timeoutMs: 10_000, keep: {},
  };
}

// ---------------------------------------------------------------- path helpers
const PH = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
export const placeholders = (path: string) => [...path.matchAll(PH)].map((m) => m[1]!);
/** Make `request.path` and the "in the address" fields agree (the server rejects any mismatch). */
export function reconcilePath(path: string, fields: FieldDraft[]): string {
  const want = fields.filter((f) => f.place === "path").map((f) => f.name);
  let p = path.replace(/\/?\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, n: string) => (want.includes(n) ? m : ""));
  if (!p.startsWith("/")) p = `/${p}`;
  for (const n of want) if (!placeholders(p).includes(n)) p = `${p.replace(/\/+$/, "")}/{{${n}}}`;
  return p;
}
export const renamePlaceholder = (path: string, from: string, to: string) => path.replace(new RegExp(`\\{\\{\\s*${from}\\s*\\}\\}`, "g"), `{{${to}}}`);

// ---------------------------------------------------------------- draft -> manifest
export function fieldSchema(f: FieldDraft): Record<string, unknown> {
  const hint = f.example ? `${f.label} (for example: ${f.example})` : f.label;
  switch (f.type) {
    case "number": return { type: "number", description: hint };
    case "boolean": return { type: "boolean", description: hint };
    case "date": return { type: "string", format: "date", description: `${hint}. Format YYYY-MM-DD` };
    case "choice": { const opts = parseChoices(f.choices); return { type: "string", ...(opts.length ? { enum: opts } : {}), description: hint }; }
    default: return { type: "string", maxLength: 500, description: hint };
  }
}
export const parseChoices = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 30);

export function autoDescription(d: ToolDraft): string {
  const purpose = d.purpose.trim() || (d.title.trim() ? `${d.title.trim()}.` : "");
  const req = d.fields.filter((f) => f.required).map((f) => f.label);
  const opt = d.fields.filter((f) => !f.required).map((f) => f.label);
  const asks = [req.length ? `Ask the customer for: ${req.join(", ")}.` : "", opt.length ? `Optional: ${opt.join(", ")}.` : ""].filter(Boolean).join(" ");
  return `${purpose} ${asks}${d.confirmBeforeRun ? " Confirm the details with the customer before it runs." : ""}`.trim().slice(0, 1000);
}
export const descriptionOf = (d: ToolDraft) => (d.descriptionEdited && d.description.trim() ? d.description.trim() : autoDescription(d));

export function buildManifest(d: ToolDraft): ToolManifestV2 | Record<string, unknown> {
  const fields = d.fields.filter((f) => f.name);
  const m: Record<string, unknown> = {
    version: 2,
    name: d.name,
    description: descriptionOf(d),
    inputSchema: {
      type: "object", additionalProperties: false,
      required: fields.filter((f) => f.required).map((f) => f.name),
      properties: Object.fromEntries(fields.map((f) => [f.name, fieldSchema(f)])),
    },
    outputSchema: d.keep.outputSchema ?? { type: "object" },
    connectionId: d.connectionId,
    request: {
      method: d.method,
      path: reconcilePath(d.path, fields),
      fields: fields.map((f) => ({ name: f.name, in: f.place, ...(f.as ? { as: f.as } : {}) })),
      ...(d.keep.headers && Object.keys(d.keep.headers).length ? { headers: d.keep.headers } : {}),
      ...(d.keep.bodyTemplate ? { bodyTemplate: d.keep.bodyTemplate } : {}),
    },
    timeoutMs: d.timeoutMs,
    onFailure: d.onFailure,
    confirmBeforeRun: d.confirmBeforeRun,
  };
  const retry = d.keep.retry ?? (d.method === "GET" ? { attempts: 2, baseMs: 300 } : undefined);
  if (retry && ["GET", "PUT", "DELETE"].includes(d.method)) m.retry = retry;
  if (d.mapping.length) m.responseMapping = Object.fromEntries(d.mapping.map((x) => [x.key, x.path]));
  if (d.stages.length) m.allowedStages = d.stages;
  return m;
}

export interface Problem { where: "connect" | "ask" | "send" | "rules"; text: string }
/** Plain-language problems that block saving. Empty list = the manifest passes the shared schema. */
export function problems(d: ToolDraft, takenNames: string[]): Problem[] {
  const out: Problem[] = [];
  if (!d.connectionId) out.push({ where: "connect", text: "Choose or create a connection first." });
  if (!d.title.trim() && !d.name) out.push({ where: "ask", text: "Give the tool a short name." });
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(d.name)) out.push({ where: "ask", text: "The internal name must use lowercase letters, digits and underscores, and start with a letter." });
  else if (takenNames.includes(d.name) || BUILTIN_TOOLS.includes(d.name)) out.push({ where: "ask", text: `The name "${d.name}" is already used. Pick another.` });
  const names = new Set<string>();
  for (const f of d.fields) {
    if (!f.label.trim()) out.push({ where: "ask", text: "Every question needs a label." });
    else if (!f.name) out.push({ where: "ask", text: `"${f.label}" needs a field name.` });
    if (names.has(f.name)) out.push({ where: "ask", text: `Two questions share the field name ${f.name}.` });
    names.add(f.name);
    if (f.type === "choice" && parseChoices(f.choices).length < 2) out.push({ where: "ask", text: `"${f.label}" needs at least two choices.` });
  }
  if (!d.stages.length) out.push({ where: "rules", text: "Pick at least one moment when the AI may use it." });
  if (out.length) return out;
  const r = toolManifestV2Schema.safeParse(buildManifest(d));
  if (!r.success) for (const i of r.error.issues.slice(0, 4)) out.push({ where: i.path[0] === "request" ? "send" : "ask", text: `${i.path.join(".") || "tool"}: ${i.message}` });
  return out;
}

// ---------------------------------------------------------------- manifest -> draft (edit / duplicate)
export function isV2(m: ToolManifest): m is ToolManifestV2 { return m.version === 2; }
export function draftFromManifest(m: ToolManifestV2): ToolDraft {
  const props = ((m.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {});
  const req = new Set(((m.inputSchema as { required?: string[] }).required ?? []));
  const fields: FieldDraft[] = Object.entries(props).map(([name, s]) => {
    const rf = m.request.fields.find((x) => x.name === name);
    const desc = typeof s.description === "string" ? s.description : name;
    const ex = /\(for example: (.*?)\)/.exec(desc);
    const label = desc.replace(/ \(for example: .*?\)/, "").replace(/\. Format YYYY-MM-DD$/, "") || humanize(name);
    const type: FieldType = Array.isArray(s.enum) ? "choice" : s.type === "number" || s.type === "integer" ? "number" : s.type === "boolean" ? "boolean" : s.format === "date" ? "date" : "text";
    return { id: newId(), label, type, required: req.has(name), example: ex?.[1] ?? "", choices: Array.isArray(s.enum) ? (s.enum as unknown[]).join(", ") : "", name, nameEdited: true, place: (rf?.in === "header" ? "query" : (rf?.in ?? defaultPlace(m.request.method))) as Place, ...(rf?.as ? { as: rf.as } : {}) };
  });
  return {
    title: humanize(m.name), name: m.name, nameEdited: true, purpose: "", description: m.description, descriptionEdited: true, connectionId: m.connectionId,
    method: m.request.method, path: m.request.path, fields, mapping: Object.entries(m.responseMapping ?? {}).map(([key, path]) => ({ key, path })),
    stages: (m.allowedStages ?? ["engaged", "qualified", "booking_offered"]).filter((s) => s !== "handoff_requested") as Stage[], confirmBeforeRun: m.confirmBeforeRun, onFailure: m.onFailure, timeoutMs: m.timeoutMs,
    keep: { headers: m.request.headers, bodyTemplate: m.request.bodyTemplate, retry: m.retry ? { attempts: m.retry.attempts, baseMs: m.retry.baseMs } : undefined, outputSchema: m.outputSchema },
  };
}

// ---------------------------------------------------------------- previews and samples
const MASK = "••••••";
export function sampleOf(f: FieldDraft): string {
  if (f.example) return f.example;
  return f.type === "number" ? "1" : f.type === "boolean" ? "true" : f.type === "date" ? "2026-03-14" : f.type === "choice" ? parseChoices(f.choices)[0] ?? "" : "";
}
export function coerce(f: FieldDraft, raw: string): unknown {
  if (f.type === "number") return raw.trim() === "" ? undefined : Number(raw);
  if (f.type === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  return raw === "" ? undefined : raw;
}
export function sampleValues(d: ToolDraft, raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of d.fields) { const v = coerce(f, raw[f.name] ?? ""); if (v !== undefined) out[f.name] = v; }
  return out;
}

export function authHeaderPreview(c: Pick<Connection, "authType" | "authHeaderName"> | undefined): Array<[string, string]> {
  if (!c) return [];
  switch (c.authType) {
    case "bearer": return [["Authorization", `Bearer ${MASK}`]];
    case "basic": return [["Authorization", `Basic ${MASK}`]];
    case "api_key": return [[c.authHeaderName || "X-API-Key", MASK]];
    case "hmac": return [["X-Yulona-Timestamp", "1760000000"], ["X-Yulona-Signature", `v1=${MASK}`]];
    default: return [];
  }
}
/** What the request will look like, with the secret masked. Placeholders show the example (or the label in angle brackets). */
export function previewRequest(d: ToolDraft, conn: Pick<Connection, "baseUrl" | "authType" | "authHeaderName"> | undefined) {
  const val = (f: FieldDraft) => sampleOf(f) || `<${f.label || f.name}>`;
  const fields = d.fields.filter((f) => f.name);
  let path = reconcilePath(d.path, fields);
  for (const f of fields.filter((x) => x.place === "path")) path = path.replace(new RegExp(`\\{\\{\\s*${f.name}\\s*\\}\\}`, "g"), encodeURIComponent(val(f)).replace(/%3C/g, "<").replace(/%3E/g, ">"));
  const q = fields.filter((f) => f.place === "query").map((f) => `${f.as ?? f.name}=${encodeURIComponent(val(f)).replace(/%3C/g, "<").replace(/%3E/g, ">")}`);
  const body = fields.filter((f) => f.place === "body");
  const bodyObj = d.keep.bodyTemplate ? null : Object.fromEntries(body.map((f) => [f.as ?? f.name, f.type === "number" && sampleOf(f) ? Number(sampleOf(f)) : f.type === "boolean" ? sampleOf(f) !== "false" : val(f)]));
  const headers: Array<[string, string]> = [["Accept", "application/json"], ...(body.length || d.keep.bodyTemplate ? [["Content-Type", "application/json"] as [string, string]] : []), ...Object.entries(d.keep.headers ?? {}), ...authHeaderPreview(conn)];
  return {
    method: d.method,
    url: `${(conn?.baseUrl ?? "https://your-system.example").replace(/\/+$/, "")}${path}${q.length ? `?${q.join("&")}` : ""}`,
    headers,
    body: d.keep.bodyTemplate ? d.keep.bodyTemplate : bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj, null, 2) : undefined,
  };
}

/** Plain-language reason for a /tools/test or connection-test error code. */
export function explainError(e: { code: string; message: string; status?: number } | null): string {
  if (!e) return "";
  switch (e.code) {
    case "invalid_input": return "The sample answers do not fit the questions (a required one is empty, or a number is not a number). Nothing was sent.";
    case "bad_input": return `The request could not be built: ${e.message}`;
    case "connection_unavailable": return "The connection has no saved secret. Open it and enter one.";
    case "ssrf_blocked": return "That address points to a private or blocked network. Use your public https address.";
    case "timeout": return "Your system did not answer in time.";
    case "network_error": return "Could not reach your system. Check the address and that it is online.";
    case "http_error": return e.status === 401 || e.status === 403 ? `Your system refused the sign-in (${e.status}). Check the secret on the connection.` : e.status === 404 ? "Your system answered \"not found\" (404). Check the path." : `Your system answered with an error (${e.status ?? "HTTP"}).`;
    case "response_too_large": return "The answer was too large to read (over 256 KB).";
    case "not_json": return "Your system did not answer with JSON, so the fields cannot be read back. Remove the read-back fields or change the endpoint.";
    default: return e.message;
  }
}
