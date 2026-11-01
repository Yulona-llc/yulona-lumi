import { createHmac } from "node:crypto";
import { decryptJson } from "@yulona/crypto";
import { withTenant, type Db } from "@yulona/db";
import type { ToolManifestV2 } from "@yulona/shared";
import { safeFetch, SsrfError, type Resolver } from "./ssrf";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- connections
export type ConnectionAuthType = "none" | "bearer" | "api_key" | "basic" | "hmac";
export interface ResolvedConnection {
  id: string;
  name: string;
  baseUrl: string;
  authType: ConnectionAuthType;
  /** api_key: the header carrying the key (default `X-API-Key`) */
  authHeaderName?: string | null;
  /** decrypted credential. Server-side only: never goes into prompts, tool_executions, API responses or logs. */
  secret?: string;
}
export type ConnectionResolver = (tenantId: string, connectionId: string) => Promise<ResolvedConnection | null>;

export const connectionAad = (tenantId: string, id: string) => `toolconn:${tenantId}:${id}`;

/** Loads + decrypts a tenant's connection (tenant-scoped via RLS and an explicit tenant_id filter). */
export function createConnectionResolver(deps: { db: Db; encryptionKey?: string }): ConnectionResolver {
  return async (tenantId, connectionId) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) return null;
    const row = await withTenant(deps.db, tenantId, async (tx) => {
      const [r] = await tx<{ id: string; name: string; baseUrl: string; authType: ConnectionAuthType; authHeaderName: string | null; secretEncrypted: string | null }[]>`
        SELECT id, name, base_url, auth_type, auth_header_name, secret_encrypted FROM tool_connections
        WHERE tenant_id = ${tenantId} AND id = ${connectionId}`;
      return r ?? null;
    });
    if (!row) return null;
    let secret: string | undefined;
    if (row.secretEncrypted) {
      if (!deps.encryptionKey) throw new Error("ENCRYPTION_KEY is not configured");
      secret = decryptJson<{ secret: string }>(deps.encryptionKey, row.secretEncrypted, connectionAad(tenantId, row.id)).secret;
    }
    return { id: row.id, name: row.name, baseUrl: row.baseUrl, authType: row.authType, authHeaderName: row.authHeaderName, secret };
  };
}

// ---------------------------------------------------------------- request building
export class ToolBuildError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const SECRET_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|signature|credential|cookie)/i;

/** Masks values whose key looks sensitive (used for logged/returned inputs and request echoes). */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, SECRET_KEY.test(k) && v != null ? "***" : maskSecrets(v, depth + 1)]));
}

/** Removes every occurrence of the credential (and its base64 form) from text that may be shown or stored. */
export function scrub(text: string, secret?: string): string {
  if (!secret || secret.length < 4) return text;
  let out = text.split(secret).join("***");
  const b64 = Buffer.from(secret).toString("base64");
  if (b64.length >= 4) out = out.split(b64).join("***");
  return out;
}

export interface RedactedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Lowercase names of the credential headers applied from the connection. */
  authHeaders: string[];
  body?: string;
  redacted: RedactedRequest;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const scalar = (v: unknown): string => (typeof v === "string" ? v : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

function renderBody(template: string, values: Json): string {
  // "{{x}}" as a whole JSON string keeps the field's type; {{x}} inside a longer string is interpolated (escaped)
  const typed = template.replace(/"\{\{\s*([A-Za-z0-9_]+)\s*\}\}"/g, (_, k: string) => JSON.stringify(values[k] ?? null));
  const out = typed.replace(PLACEHOLDER, (_, k: string) => JSON.stringify(values[k] == null ? "" : scalar(values[k])).slice(1, -1));
  try {
    return JSON.stringify(JSON.parse(out));
  } catch {
    throw new ToolBuildError("bad_input", "the body template did not produce valid JSON for these values");
  }
}

function buildRequest(m: ToolManifestV2, conn: ResolvedConnection, input: Json, now: number): BuiltRequest {
  const r = m.request;
  const val = (name: string) => input[name];
  // ---- path
  const path = r.path.replace(PLACEHOLDER, (_, k: string) => {
    const v = val(k);
    if (v === undefined || v === null || v === "") throw new ToolBuildError("bad_input", `missing value for path field "${k}"`);
    const s = scalar(v);
    if (s === "." || s === ".." || /[\\\r\n]/.test(s)) throw new ToolBuildError("bad_input", `invalid value for path field "${k}"`);
    return encodeURIComponent(s);
  });
  const base = conn.baseUrl.replace(/\/+$/, "");
  let baseUrl: URL;
  let u: URL;
  try {
    baseUrl = new URL(base);
    u = new URL(base + path);
  } catch {
    throw new ToolBuildError("bad_input", "invalid request URL");
  }
  const basePrefix = baseUrl.pathname.replace(/\/+$/, "");
  if (u.origin !== baseUrl.origin || (basePrefix && !u.pathname.startsWith(`${basePrefix}/`) && u.pathname !== basePrefix)) {
    throw new ToolBuildError("bad_input", "the request path leaves the connection's base URL");
  }
  // ---- query / headers / body
  const headers: Record<string, string> = { accept: "application/json" };
  const bodyObj: Json = {};
  for (const f of r.fields) {
    const v = val(f.name);
    if (v === undefined || v === null) continue;
    const key = f.as ?? f.name;
    if (f.in === "query") {
      for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(key, scalar(item));
    } else if (f.in === "header") {
      const s = scalar(v);
      if (/[\r\n]/.test(s)) throw new ToolBuildError("bad_input", `invalid value for header field "${f.name}"`);
      headers[key.toLowerCase()] = s;
    } else if (f.in === "body") bodyObj[key] = v;
  }
  for (const [h, tpl] of Object.entries(r.headers ?? {})) {
    const s = tpl.replace(PLACEHOLDER, (_, k: string) => scalar(val(k) ?? ""));
    if (/[\r\n]/.test(s)) throw new ToolBuildError("bad_input", `invalid header "${h}"`);
    headers[h.toLowerCase()] = s;
  }
  let body: string | undefined;
  if (r.method !== "GET" && r.method !== "DELETE") {
    if (r.bodyTemplate !== undefined) body = renderBody(r.bodyTemplate, input);
    else if (Object.keys(bodyObj).length) body = JSON.stringify(bodyObj);
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  if (body !== undefined && body.length > 100_000) throw new ToolBuildError("bad_input", "request body too large");

  // ---- auth (applied last so a tool can never override it)
  const redactedHeaders: Record<string, string> = {};
  const authHeaders: string[] = [];
  const auth = (name: string, value: string, shown: string) => {
    authHeaders.push(name);
    headers[name] = value;
    redactedHeaders[name] = shown;
  };
  if (conn.authType !== "none" && !conn.secret) throw new ToolBuildError("connection_unavailable", "the connection has no credential");
  switch (conn.authType) {
    case "bearer": auth("authorization", `Bearer ${conn.secret}`, "Bearer ***"); break;
    case "api_key": auth((conn.authHeaderName || "X-API-Key").toLowerCase(), conn.secret!, "***"); break;
    case "basic": auth("authorization", `Basic ${Buffer.from(conn.secret!).toString("base64")}`, "Basic ***"); break;
    case "hmac": {
      // Same scheme as outbound webhooks (packages/integrations/src/signing.ts): HMAC-SHA256(secret, `${ts}.${rawBody}`)
      const ts = String(Math.floor(now / 1000));
      const sig = `v1=${createHmac("sha256", conn.secret!).update(`${ts}.${body ?? ""}`).digest("hex")}`;
      auth("x-yulona-timestamp", ts, ts);
      auth("x-yulona-signature", sig, "v1=***");
      auth("x-lumi-timestamp", ts, ts);
      auth("x-lumi-signature", sig, "v1=***");
      break;
    }
    default: break;
  }
  const shownHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) shownHeaders[k] = redactedHeaders[k] ?? (SECRET_KEY.test(k) ? "***" : v);
  const shownUrl = new URL(u.toString());
  for (const k of [...shownUrl.searchParams.keys()]) if (SECRET_KEY.test(k)) shownUrl.searchParams.set(k, "***");
  let shownBody: string | undefined;
  if (body !== undefined) {
    try { shownBody = JSON.stringify(maskSecrets(JSON.parse(body))); } catch { shownBody = "[body]"; }
  }
  return {
    method: r.method, url: u.toString(), headers, authHeaders, body,
    redacted: { method: r.method, url: shownUrl.toString(), headers: shownHeaders, ...(shownBody !== undefined ? { body: scrub(shownBody, conn.secret).slice(0, 2000) } : {}) },
  };
}

// ---------------------------------------------------------------- response mapping + field tree
function tokens(path: string): (string | { index: number | "*" })[] {
  const out: (string | { index: number | "*" })[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d*)\]/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    else out.push({ index: m[2] === "" ? "*" : Number(m[2]) });
  }
  return out;
}
/** `a.b`, `a[0].b`, `items[].name` (maps over the array), `[]` for a root array. */
export function extractPath(data: unknown, path: string): unknown {
  const walk = (cur: unknown, i: number, toks: ReturnType<typeof tokens>): unknown => {
    if (i >= toks.length) return cur;
    const t = toks[i]!;
    if (typeof t === "string") {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      return walk((cur as Json)[t], i + 1, toks);
    }
    if (!Array.isArray(cur)) return undefined;
    if (t.index === "*") return cur.map((x) => walk(x, i + 1, toks));
    return walk(cur[t.index], i + 1, toks);
  };
  return walk(data, 0, tokens(path));
}

export interface FieldNode {
  name: string;
  /** usable as a `responseMapping` value */
  path: string;
  type: "string" | "number" | "boolean" | "null" | "object" | "array";
  /** short preview of the value (scalars) */
  sample?: string | number | boolean | null;
  /** arrays: type of the first element, and the length */
  itemType?: FieldNode["type"];
  length?: number;
  children?: FieldNode[];
}
const typeOf = (v: unknown): FieldNode["type"] => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : (typeof v as "string" | "number" | "boolean"));
const MAX_NODES = 300;

/** Click-to-map tree of a JSON response. Array elements are described by the first element (`items[].name`). */
export function buildFieldTree(data: unknown): { rootType: FieldNode["type"]; fields: FieldNode[] } {
  let count = 0;
  const fieldsOf = (obj: unknown, prefix: string, depth: number): FieldNode[] => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj) || depth > 6) return [];
    const out: FieldNode[] = [];
    for (const [k, v] of Object.entries(obj as Json).slice(0, 60)) {
      if (count++ > MAX_NODES) break;
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(node(k, path, v, depth));
    }
    return out;
  };
  const node = (name: string, path: string, v: unknown, depth: number): FieldNode => {
    const type = typeOf(v);
    const n: FieldNode = { name, path, type };
    if (type === "array") {
      const arr = v as unknown[];
      n.length = arr.length;
      const first = arr[0];
      if (first !== undefined) {
        n.itemType = typeOf(first);
        if (n.itemType === "object") n.children = fieldsOf(first, `${path}[]`, depth + 1);
      }
    } else if (type === "object") n.children = fieldsOf(v, path, depth + 1);
    else n.sample = typeof v === "string" ? v.slice(0, 80) : (v as number | boolean | null);
    return n;
  };
  const rootType = typeOf(data);
  if (rootType === "array") {
    const first = (data as unknown[])[0];
    return { rootType, fields: first !== null && typeof first === "object" && !Array.isArray(first) ? fieldsOf(first, "[]", 0) : [] };
  }
  return { rootType, fields: fieldsOf(data, "", 0) };
}

// ---------------------------------------------------------------- execution
export interface HttpToolOptions {
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface HttpToolResult {
  ok: boolean;
  latencyMs: number;
  attempts: number;
  request?: RedactedRequest;
  response?: { status: number; contentType: string; excerpt: string; truncated: boolean };
  /** parsed JSON body (server-side use: mapping + field tree) */
  json?: unknown;
  /** the value handed to the model: mapped response (or the whole JSON) */
  output?: unknown;
  error?: { code: string; message: string; status?: number };
}

const EXCERPT_BYTES = 4096;
const IDEMPOTENT = new Set(["GET", "PUT", "DELETE"]);

/** Performs the manifest's request against the connection: SSRF-safe, authenticated, retried (idempotent only), redacted. */
export async function callConnection(m: ToolManifestV2, conn: ResolvedConnection, input: Json, opts: HttpToolOptions = {}): Promise<HttpToolResult> {
  const started = Date.now();
  const clock = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = (code: string, message: string, extra: Partial<HttpToolResult> & { status?: number } = {}): HttpToolResult => {
    const { status, ...rest } = extra;
    return { ok: false, latencyMs: Date.now() - started, attempts: 1, ...rest, error: { code, message: scrub(message, conn.secret).slice(0, 300), ...(status ? { status } : {}) } };
  };
  let built: BuiltRequest;
  try {
    built = buildRequest(m, conn, input, clock());
  } catch (e) {
    if (e instanceof ToolBuildError) return fail(e.code, e.message);
    throw e;
  }
  const attempts = m.retry && IDEMPOTENT.has(m.request.method) ? m.retry.attempts : 1;
  let last: HttpToolResult = fail("network_error", "no attempt made");
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep((m.retry?.baseMs ?? 300) * 2 ** (i - 1));
    // re-sign each attempt (timestamp freshness)
    const req = i === 0 ? built : buildRequest(m, conn, input, clock());
    let res;
    try {
      res = await safeFetch(req.url, { method: req.method, headers: req.headers, sensitiveHeaders: req.authHeaders, body: req.body, timeoutMs: m.timeoutMs, maxBytes: 256 * 1024, maxRedirects: 3, resolver: opts.resolver, fetchImpl: opts.fetchImpl });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError" || msg === "request timed out";
      if (timedOut) last = fail("timeout", `no response within ${m.timeoutMs} ms`, { request: req.redacted });
      else if (e instanceof SsrfError) last = fail(msg === "response too large" ? "response_too_large" : "ssrf_blocked", msg, { request: req.redacted });
      else last = fail("network_error", msg || "network error", { request: req.redacted });
      last.attempts = i + 1;
      if (last.error!.code === "timeout" || last.error!.code === "network_error") continue;
      return last;
    }
    const text = scrub(new TextDecoder().decode(res.body), conn.secret);
    const response = { status: res.status, contentType: res.contentType, excerpt: text.slice(0, EXCERPT_BYTES), truncated: text.length > EXCERPT_BYTES };
    let json: unknown;
    let parsed = false;
    try {
      json = JSON.parse(text);
      parsed = true;
    } catch {
      /* not JSON */
    }
    if (res.status >= 400) {
      last = { ok: false, latencyMs: Date.now() - started, attempts: i + 1, request: built.redacted, response, error: { code: "http_error", message: `the backend returned HTTP ${res.status}`, status: res.status } };
      if (res.status >= 500 || res.status === 429) continue;
      return last;
    }
    if (m.responseMapping) {
      if (!parsed) return { ok: false, latencyMs: Date.now() - started, attempts: i + 1, request: built.redacted, response, error: { code: "not_json", message: "the backend did not return JSON, so the response mapping cannot be applied" } };
      const output = Object.fromEntries(Object.entries(m.responseMapping).map(([out, p]) => [out, extractPath(json, p) ?? null]));
      return { ok: true, latencyMs: Date.now() - started, attempts: i + 1, request: built.redacted, response, json, output };
    }
    return { ok: true, latencyMs: Date.now() - started, attempts: i + 1, request: built.redacted, response, ...(parsed ? { json, output: json } : { output: { text: text.slice(0, 4000) } }) };
  }
  last.latencyMs = Date.now() - started;
  return last;
}
