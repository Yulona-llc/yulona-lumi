import { toolManifestSchema, type ConversionStage, type ToolManifest, type ToolManifestV2 } from "@yulona/shared";
import { callConnection, maskSecrets, type ConnectionResolver } from "./http-tool";
import { safeFetch, type Resolver } from "./ssrf";
import { DEFAULT_CUSTOM_TOOL_STAGES, STAGE_ACTIONS } from "./stage";
import type { ToolSpec } from "./ports";
import type { AgentConfig, HandoffType, Lead, ToolRun } from "./types";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- minimal JSON-schema validation
/** Validates the subset of JSON Schema used by tool manifests. Returns an error string or null. */
export function validateJsonSchema(schema: Json, value: unknown, path = "input"): string | null {
  const type = schema.type as string | undefined;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
  switch (type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
      const props = (schema.properties ?? {}) as Record<string, Json>;
      for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in (value as Json))) return `${path}.${r} is required`;
      for (const [k, v] of Object.entries(value as Json)) {
        if (props[k]) {
          const e = validateJsonSchema(props[k]!, v, `${path}.${k}`);
          if (e) return e;
        } else if (schema.additionalProperties === false) return `${path}.${k} is not allowed`;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long`;
      if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short`;
      return null;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
      if (type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
      if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is too small`;
      if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is too large`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has too many items`;
      const item = schema.items as Json | undefined;
      if (item) for (let i = 0; i < value.length; i++) { const e = validateJsonSchema(item, value[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- built-in manifests
const str = (maxLength: number) => ({ type: "string", maxLength });
const builtin = (name: string, description: string, props: Json, required: string[] = []): ToolManifest => ({
  version: 1,
  name,
  description,
  inputSchema: { type: "object", properties: props, required, additionalProperties: false },
  outputSchema: { type: "object" },
  authType: "none",
});

export const BUILTIN_MANIFESTS: Record<string, ToolManifest> = {
  collect_contact: builtin(
    "collect_contact",
    "Save contact details the customer shared (name, email, phone). Use ask_for to request missing details.",
    {
      name: str(100), email: str(254), phone: str(32),
      ask_for: { type: "array", items: { type: "string", enum: ["name", "email", "phone"] }, maxItems: 3 },
    },
  ),
  qualify_lead: builtin(
    "qualify_lead",
    "Record what the customer needs, their budget and timeline.",
    { need: str(500), budget: str(100), timeline: str(100), score: { type: "integer", minimum: 0, maximum: 100 } },
    ["need"],
  ),
  escalate_to_human: builtin(
    "escalate_to_human",
    "Hand the conversation to a human. type=uncertainty when unsure/out of scope, stage when the lead is ready for a salesperson.",
    { reason: str(500), type: { type: "string", enum: ["uncertainty", "stage"] } },
    ["reason"],
  ),
};

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const PHONE_RE = /^\+?[0-9][0-9 ()\-.]{5,30}[0-9]$/;

// ---------------------------------------------------------------- resolution + gating
export interface ResolvedTool {
  manifest: ToolManifest;
  custom: boolean;
  /** executed in-process via ExternalToolProvider (needs DB/tenant credentials), not over HTTP */
  external?: boolean;
  secret?: string;
}

/**
 * In-process tools supplied by the host (e.g. `@yulona/ops` calendar tools). Kept as an interface so
 * ai-runtime does not depend on those packages. A tool is offered only if the agent lists its name
 * in `enabledTools` and the current stage is in the manifest's `allowedStages`.
 * `failed` means the provider already raised the system_failure handoff.
 */
export interface ExternalToolProvider {
  manifests: ToolManifest[];
  execute(
    ctx: { tenantId: string; conversationId: string | null },
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ kind: "ok" | "rejected" | "failed"; output?: unknown; error?: string }>;
}

export function resolveTools(agent: AgentConfig, external?: ExternalToolProvider): Map<string, ResolvedTool> {
  const m = new Map<string, ResolvedTool>();
  for (const n of agent.enabledTools) {
    const b = BUILTIN_MANIFESTS[n];
    if (b) m.set(n, { manifest: b, custom: false });
  }
  for (const ct of agent.customTools) {
    // The dashboard stores bare manifests; older/programmatic configs use { manifest, secret? }. Accept both.
    const wrapped = typeof ct === "object" && ct !== null && "manifest" in ct && typeof (ct as { manifest: unknown }).manifest === "object";
    const parsed = toolManifestSchema.safeParse(wrapped ? (ct as { manifest: unknown }).manifest : ct);
    if (!parsed.success || BUILTIN_MANIFESTS[parsed.data.name] || !agent.enabledTools.includes(parsed.data.name)) continue;
    m.set(parsed.data.name, { manifest: parsed.data, custom: true, secret: wrapped ? (ct as { secret?: string }).secret : undefined });
  }
  for (const manifest of external?.manifests ?? []) {
    if (BUILTIN_MANIFESTS[manifest.name] || m.has(manifest.name) || !agent.enabledTools.includes(manifest.name)) continue;
    m.set(manifest.name, { manifest, custom: true, external: true });
  }
  return m;
}

export function isToolAllowedInStage(t: ResolvedTool, stage: ConversionStage): boolean {
  if (!t.custom) return STAGE_ACTIONS[stage].includes(t.manifest.name);
  return (t.manifest.allowedStages ?? DEFAULT_CUSTOM_TOOL_STAGES).includes(stage);
}

const CONFIRM_NOTE = " Before calling, tell the customer what will be done and ask them to confirm; only after they agree call again with confirmed=true.";
/** Parameters offered to the model; tools that need confirmation get an extra `confirmed` flag. */
function withConfirm(t: ResolvedTool): Record<string, unknown> {
  if (t.manifest.version !== 2 || !t.manifest.confirmBeforeRun) return t.manifest.inputSchema;
  const sch = t.manifest.inputSchema as { properties?: Record<string, unknown> };
  return { ...sch, properties: { ...(sch.properties ?? {}), confirmed: { type: "boolean", description: `Set true only after the customer explicitly confirmed.${CONFIRM_NOTE}` } } };
}

/** Tool specs offered to the model: ONLY those legal in the current stage. */
export function toolSpecsForStage(tools: Map<string, ResolvedTool>, stage: ConversionStage): ToolSpec[] {
  return [...tools.values()]
    .filter((t) => isToolAllowedInStage(t, stage))
    .map((t) => ({ name: t.manifest.name, description: t.manifest.description, parameters: withConfirm(t) }));
}

// ---------------------------------------------------------------- execution
export interface ToolEffects {
  leadPatch?: Lead;
  ask?: ("name" | "email" | "phone")[];
  escalate?: { type: HandoffType; reason: string };
  qualified?: boolean;
}
export interface ToolExecution {
  run: ToolRun;
  effects: ToolEffects;
  /** policy/validation rejection (fed back to the model) vs real failure (=> system_failure handoff) */
  kind: "ok" | "rejected" | "failed";
  /** external tool already raised the handoff (do not raise a second one) */
  handoffRaised?: boolean;
  /** text handed back to the model as the tool result */
  modelResult: string;
}

export interface ExecContext {
  stage: ConversionStage;
  lead: Lead;
  /** sandbox: no outbound HTTP; custom tools are reported, not called */
  dryRun?: boolean;
  external?: ExternalToolProvider;
  tenantId?: string;
  conversationId?: string | null;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** resolves + decrypts tool connections (manifest v2); the credential never leaves this process */
  connections?: ConnectionResolver;
  sleep?: (ms: number) => Promise<void>;
}

const trim = (v: unknown, n = 500): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);

function runBuiltin(name: string, input: Json, lead: Lead): { output: Json; effects: ToolEffects } {
  switch (name) {
    case "collect_contact": {
      const patch: Lead = {};
      const rejected: string[] = [];
      const nm = trim(input.name, 100);
      if (nm) patch.name = nm;
      const em = trim(input.email, 254);
      if (em) EMAIL_RE.test(em) ? (patch.email = em.toLowerCase()) : rejected.push("email");
      const ph = trim(input.phone, 32);
      if (ph) PHONE_RE.test(ph) ? (patch.phone = ph) : rejected.push("phone");
      const merged = { ...lead, ...patch };
      const ask = new Set<"name" | "email" | "phone">(((input.ask_for as string[] | undefined) ?? []) as never);
      for (const r of rejected) ask.add(r as "email" | "phone");
      for (const f of ["name", "email", "phone"] as const) if (rejected.includes(f)) ask.add(f);
      return {
        output: { saved: Object.keys(patch), invalid: rejected, missing: (["name", "email", "phone"] as const).filter((f) => !merged[f]) },
        effects: { leadPatch: patch, ask: ask.size ? [...ask] : undefined },
      };
    }
    case "qualify_lead": {
      const patch: Lead = { need: trim(input.need), budget: trim(input.budget, 100), timeline: trim(input.timeline, 100) };
      if (typeof input.score === "number") patch.score = input.score;
      const merged = { ...lead, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Lead;
      const qualified = !!merged.need && !!(merged.budget || merged.timeline);
      return { output: { recorded: true, qualified }, effects: { leadPatch: patch, qualified } };
    }
    case "escalate_to_human":
      return {
        output: { escalated: true },
        effects: { escalate: { type: input.type === "stage" ? "stage" : "uncertainty", reason: trim(input.reason) ?? "requested by AI" } },
      };
    default:
      throw new Error("unknown builtin");
  }
}

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Json)[part];
  }
  return cur;
}

async function runCustom(t: ResolvedTool, input: Json, ctx: ExecContext): Promise<unknown> {
  if (t.manifest.version !== 1) throw new Error("not a v1 manifest");
  const tpl = t.manifest.endpointTemplate;
  if (!tpl) throw new Error("tool has no endpointTemplate");
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i.exec(tpl.trim());
  const method = (m?.[1] ?? "POST").toUpperCase();
  let url = m ? m[2]! : tpl.trim();
  const used = new Set<string>();
  url = url.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => {
    used.add(k);
    return encodeURIComponent(String(input[k] ?? ""));
  });
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !used.has(k)));
  const headers: Record<string, string> = { accept: "application/json" };
  if (t.manifest.authType === "api_key" && t.secret) headers["x-api-key"] = t.secret;
  else if ((t.manifest.authType === "bearer" || t.manifest.authType === "oauth2") && t.secret) headers.authorization = `Bearer ${t.secret}`;
  let body: string | undefined;
  if (method === "GET" || method === "DELETE") {
    const u = new URL(url);
    for (const [k, v] of Object.entries(rest)) u.searchParams.set(k, String(v));
    url = u.toString();
  } else {
    body = JSON.stringify(rest);
    headers["content-type"] = "application/json";
  }
  const res = await safeFetch(url, { method, headers, body, timeoutMs: ctx.timeoutMs ?? 10_000, maxBytes: 256 * 1024, maxRedirects: 3, resolver: ctx.resolver, fetchImpl: ctx.fetchImpl });
  if (res.status >= 400) throw new Error(`tool endpoint returned HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    throw new Error("tool endpoint did not return JSON");
  }
  if (!t.manifest.responseMapping) return json;
  return Object.fromEntries(Object.entries(t.manifest.responseMapping).map(([out, path]) => [out, pick(json, path)]));
}

export async function executeTool(
  agentTools: Map<string, ResolvedTool>, call: { name: string; arguments: Json }, ctx: ExecContext,
): Promise<ToolExecution> {
  const started = Date.now();
  const tool = agentTools.get(call.name);
  const v2 = tool?.manifest.version === 2 ? (tool.manifest as ToolManifestV2) : undefined;
  // `confirmed` is a runtime flag, not part of the tool's own input
  let args = call.arguments;
  let confirmed = false;
  if (v2?.confirmBeforeRun) {
    const { confirmed: c, ...rest } = args;
    confirmed = c === true;
    args = rest;
  }
  // what is stored in tool_executions: secret-looking values and header fields masked
  const headerFields = new Set(v2?.request.fields.filter((f) => f.in === "header").map((f) => f.name));
  const logged = (maskSecrets(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, headerFields.has(k) ? "***" : v]))) as Json);
  const mk = (kind: ToolExecution["kind"], output: unknown, error: string | undefined, effects: ToolEffects = {}): ToolExecution => {
    const modelResult = JSON.stringify(kind === "ok" ? output : { error });
    return {
      kind,
      effects,
      modelResult: modelResult.slice(0, 8000),
      run: { name: call.name, input: logged, output: kind === "ok" ? output : undefined, success: kind === "ok", error, latencyMs: Date.now() - started },
    };
  };
  if (!tool) return mk("rejected", undefined, "unknown_tool");
  if (!isToolAllowedInStage(tool, ctx.stage)) return mk("rejected", undefined, `tool_not_allowed_in_stage_${ctx.stage}`);
  const invalid = validateJsonSchema(tool.manifest.inputSchema, args);
  if (invalid) return mk("rejected", undefined, `invalid_input: ${invalid}`);
  try {
    if (!tool.custom) {
      const r = runBuiltin(call.name, args, ctx.lead);
      return mk("ok", r.output, undefined, r.effects);
    }
    if (tool.external) {
      if (ctx.dryRun || !ctx.external || !ctx.tenantId) return mk("ok", { dryRun: true, note: "tool not executed in sandbox" }, undefined);
      const r = await ctx.external.execute({ tenantId: ctx.tenantId, conversationId: ctx.conversationId ?? null }, call.name, args);
      const ex = mk(r.kind, r.output, r.error ?? (r.kind === "ok" ? undefined : "tool_error"));
      if (r.kind === "failed") ex.handoffRaised = true;
      return ex;
    }
    if (v2) {
      if (v2.confirmBeforeRun && !confirmed) {
        return mk("ok", { status: "confirmation_required", instruction: "Do not run this yet. Tell the customer exactly what will be done, ask them to confirm, and only after they agree call this tool again with confirmed=true.", pending: args }, undefined);
      }
      if (ctx.dryRun) return mk("ok", { dryRun: true, note: "custom tool not executed in sandbox", wouldCall: `${v2.request.method} ${v2.request.path}` }, undefined);
      return await runV2(v2, args, ctx, mk);
    }
    if (ctx.dryRun) return mk("ok", { dryRun: true, note: "custom tool not executed in sandbox", wouldCall: (tool.manifest as { endpointTemplate?: string }).endpointTemplate }, undefined);
    const out = await runCustom(tool, args, ctx);
    const size = JSON.stringify(out ?? null).length;
    return mk("ok", size > 8000 ? { truncated: true, preview: JSON.stringify(out).slice(0, 8000) } : out, undefined);
  } catch (e) {
    return mk("failed", undefined, (e as Error).message.slice(0, 300));
  }
}

async function runV2(
  m: ToolManifestV2, args: Json, ctx: ExecContext,
  mk: (kind: ToolExecution["kind"], output: unknown, error: string | undefined) => ToolExecution,
): Promise<ToolExecution> {
  const failure = (code: string, message: string): ToolExecution =>
    m.onFailure === "tell_customer"
      // the model sees the failure and tells the customer; no handoff is raised
      ? mk("rejected", undefined, `tool_failed (${code}): ${message}. Tell the customer you could not complete this right now; offer to try again later or to connect them with a person. Do not guess the result.`)
      : mk("failed", undefined, `${code}: ${message}`);
  if (!ctx.connections || !ctx.tenantId) return failure("connection_unavailable", "tool connections are not configured");
  let conn;
  try {
    conn = await ctx.connections(ctx.tenantId, m.connectionId);
  } catch {
    return failure("connection_unavailable", "the connection credential could not be read");
  }
  if (!conn) return failure("connection_not_found", "the connection for this tool no longer exists");
  const r = await callConnection(m, conn, args, { resolver: ctx.resolver, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
  if (!r.ok) return failure(r.error!.code, r.error!.message);
  const size = JSON.stringify(r.output ?? null).length;
  return mk("ok", size > 8000 ? { truncated: true, preview: JSON.stringify(r.output).slice(0, 8000) } : r.output, undefined);
}
