import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { KnowledgeRepository, SsrfError, assertSafeUrl, type ToolSpec } from "@yulona/ai-runtime";
import { AuditLogRepository, withTenant, type Db, type Tx } from "@yulona/db";
import { enqueue } from "@yulona/queue";
import { agentConfigSchema, goalsSchema, opsSettingsUpdateSchema, widgetConfigSchema, type AgentConfig, type CopilotBlock, type Role } from "@yulona/shared";
import { applyPatch } from "../agent-builder/engine";
import { AppError } from "../errors";
import { saveOpsSettings, validTz, minutes } from "../ops/settings";
import { hasMinRole } from "../platform/authz";
import { assertWithinLimit } from "../platform/limits";
import { AgentsRepository } from "../routes/agents";
import { WidgetsRepository } from "../conversations/repos";

export const PENDING_TTL_MS = 15 * 60_000;
export const MAX_KNOWLEDGE_PER_SESSION = 2;

export interface ToolCtx {
  db: Db;
  tenantId: string;
  userId: string;
  role: Role;
  sessionId: string;
  requestId?: string;
  ip?: string;
}
export interface ToolResult { ok: boolean; reply: Record<string, unknown>; blocks?: CopilotBlock[] }

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
const fail = (message: string, path = ""): ToolResult => ({ ok: false, reply: { ok: false, errors: [{ path, message }] } });
const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? ""); return s.length > 120 ? `${s.slice(0, 117)}...` : s; };
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const auditVia = (tx: Tx, ctx: ToolCtx, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown> = {}) =>
  new AuditLogRepository(tx, ctx.tenantId).record({ actorUserId: ctx.userId, action, resourceType, resourceId, metadata: { ...metadata, via: "copilot", sessionId: ctx.sessionId }, ip: ctx.ip, requestId: ctx.requestId });

/** Compact, metadata-only snapshot (counts, ids, names, statuses). Never raw knowledge, conversations or secrets. */
export async function workspaceSummary(tx: Tx, tenantId: string) {
  const [t] = await tx<{ name: string; goals: string[]; planKey: string; onboarding: { completedAt?: string; skippedAt?: string } }[]>`SELECT name, goals, plan_key, onboarding FROM tenants WHERE id = ${tenantId}`;
  const agents = await tx<{ id: string; name: string; status: string; hasGreeting: boolean; tools: number }[]>`
    SELECT id, name, status, (config->>'greeting' IS NOT NULL AND config->>'greeting' <> '') AS has_greeting, COALESCE(jsonb_array_length(config->'enabledTools'), 0)::int AS tools
    FROM agents WHERE tenant_id = ${tenantId} AND status <> 'archived' ORDER BY created_at DESC LIMIT 8`;
  const widgets = await tx<{ id: string; name: string; agentId: string | null; enabled: boolean; color: string | null; title: string | null }[]>`
    SELECT id, name, agent_id, enabled, config->>'primaryColor' AS color, config->>'title' AS title FROM widgets WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 5`;
  const [k] = await tx<{ total: number; ready: number; failed: number; pending: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ready')::int AS ready, count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending FROM knowledge_sources WHERE tenant_id = ${tenantId}`;
  const channels = await tx<{ channel: string; status: string }[]>`SELECT channel, status FROM channel_connections WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 10`;
  const [h] = await tx<{ n: number; tz: string | null }[]>`
    SELECT (SELECT count(*)::int FROM business_hours WHERE tenant_id = ${tenantId}) AS n, (SELECT timezone FROM ops_settings WHERE tenant_id = ${tenantId}) AS tz`;
  const [cal] = await tx<{ provider: string }[]>`SELECT provider FROM calendar_connections WHERE tenant_id = ${tenantId} AND status = 'active' LIMIT 1`;
  return {
    workspace: t?.name, plan: t?.planKey, goals: t?.goals ?? [], onboarding: t?.onboarding?.completedAt ? "completed" : t?.onboarding?.skippedAt ? "skipped" : "open",
    agents: agents.map((a) => ({ id: a.id, name: a.name, status: a.status, greeting: a.hasGreeting, tools: a.tools })),
    widgets: widgets.map((w) => ({ id: w.id, name: w.name, agentId: w.agentId, enabled: w.enabled, color: w.color, title: w.title })),
    knowledge: k, channels, businessHours: { slots: h?.n ?? 0, timezone: h?.tz ?? null }, calendar: cal?.provider ?? null,
  };
}

export async function nextSteps(tx: Tx, tenantId: string): Promise<{ checklist: CopilotBlock; chips: string[] }> {
  const s = await workspaceSummary(tx, tenantId);
  const published = s.agents.some((a) => a.status === "published");
  const items = [
    { label: "Create an agent", done: s.agents.length > 0, path: "/agents" },
    { label: "Add knowledge from your website", done: (s.knowledge?.ready ?? 0) > 0, path: "/knowledge" },
    { label: "Set your business hours", done: s.businessHours.slots > 0, path: "/settings/operations" },
    { label: "Customise the chat window", done: s.widgets.some((w) => !!w.color), path: "/channels" },
    { label: "Publish your agent", done: published, path: "/agents" },
  ];
  if (s.goals.includes("bookings")) items.push({ label: "Connect a calendar", done: !!s.calendar, path: "/settings/integrations" });
  const chips: string[] = [];
  if (!s.goals.length) chips.push("Set my goals");
  if (!s.knowledge?.total) chips.push("Add my website");
  if (!s.businessHours.slots) chips.push("Set business hours");
  if (s.agents.length && !published) chips.push("Publish my agent");
  return { checklist: { type: "checklist", items }, chips: chips.slice(0, 4) };
}

const OBJ = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const COPILOT_TOOLS: (ToolSpec & { minRole: Role })[] = [
  { name: "get_workspace_summary", minRole: "viewer", description: "Compact snapshot of the workspace (agents, widget, knowledge counts, channels, hours, goals).", parameters: OBJ({}) },
  { name: "update_agent_draft", minRole: "admin", description: "Change an agent's draft: name, description or config (systemPrompt, greeting, fallbackMessage, handoffMessage, enabledTools, escalationRules). Draft only; publishing is a separate step.",
    parameters: OBJ({ agentId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, config: { type: "object" } }, ["agentId"]) },
  { name: "publish_agent", minRole: "admin", description: "Ask the owner to publish an agent's current draft. This only PROPOSES: the owner confirms in the chat. Never claim it is published.",
    parameters: OBJ({ agentId: { type: "string" }, note: { type: "string" } }, ["agentId"]) },
  { name: "update_widget_appearance", minRole: "admin", description: "Change the website chat window look: title, subtitle, welcomeMessage, primaryColor (#RRGGBB), position (right|left), launcherLabel, theme (light|dark|auto), inputPlaceholder. Defaults to the first widget.",
    parameters: OBJ({ widgetId: { type: "string" }, title: { type: "string" }, subtitle: { type: "string" }, welcomeMessage: { type: "string" }, primaryColor: { type: "string" }, position: { type: "string" }, launcherLabel: { type: "string" }, theme: { type: "string" }, inputPlaceholder: { type: "string" } }) },
  { name: "add_knowledge_url", minRole: "admin", description: "Add a website for the agent to learn from. depth 1-5 (default 3), maxPages 1-25 (default 25).",
    parameters: OBJ({ url: { type: "string" }, depth: { type: "integer" }, maxPages: { type: "integer" } }, ["url"]) },
  { name: "set_business_hours", minRole: "admin", description: "Set business hours: timezone (IANA) and days [{weekday 0-6 (0=Sunday), start HH:MM, end HH:MM}].",
    parameters: OBJ({ timezone: { type: "string" }, days: { type: "array", items: OBJ({ weekday: { type: "integer" }, start: { type: "string" }, end: { type: "string" } }, ["weekday", "start", "end"]) } }, ["days"]) },
  { name: "set_goals", minRole: "admin", description: "Set the workspace goals: any of support, leads, bookings, other.", parameters: OBJ({ goals: { type: "array", items: { type: "string" } } }, ["goals"]) },
  { name: "list_channel_status", minRole: "viewer", description: "Connected channels and whether they are healthy.", parameters: OBJ({}) },
  { name: "suggest_next_steps", minRole: "viewer", description: "Show the setup checklist and suggested quick replies for what to do next.", parameters: OBJ({}) },
];
export const TOOL_SPECS: ToolSpec[] = COPILOT_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

const uuid = z.string().uuid();

/** Runs one tool as the calling user (role-checked). Never throws for model mistakes; returns errors the model can repair. */
export async function runCopilotTool(ctx: ToolCtx, name: string, rawArgs: unknown): Promise<ToolResult> {
  const spec = COPILOT_TOOLS.find((t) => t.name === name);
  if (!spec) return fail(`Unknown tool ${name}`);
  if (!hasMinRole(ctx.role, spec.minRole)) return fail("Your role does not allow this action", "role");
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  try {
    return await run(ctx, name, args);
  } catch (e) {
    if (e instanceof AppError) return fail(e.message);
    throw e;
  }
}

async function run(ctx: ToolCtx, name: string, a: Record<string, unknown>): Promise<ToolResult> {
  const { db, tenantId } = ctx;
  switch (name) {
    case "get_workspace_summary":
      return { ok: true, reply: await withTenant(db, tenantId, (tx) => workspaceSummary(tx, tenantId)) };
    case "list_channel_status": {
      const rows = await withTenant(db, tenantId, (tx) => tx<{ channel: string; name: string; status: string; healthy: boolean | null }[]>`
        SELECT channel, name, status, last_health_ok AS healthy FROM channel_connections WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 20`);
      return { ok: true, reply: { channels: rows } };
    }
    case "suggest_next_steps": {
      const s = await withTenant(db, tenantId, (tx) => nextSteps(tx, tenantId));
      return { ok: true, reply: { checklist: (s.checklist as { items: unknown[] }).items, suggestedReplies: s.chips }, blocks: [s.checklist, ...(s.chips.length ? [{ type: "chips", options: s.chips } as CopilotBlock] : [])] };
    }
    case "set_goals": {
      const g = goalsSchema.safeParse(a.goals);
      if (!g.success) return { ok: false, reply: { ok: false, errors: issues(g.error) } };
      await withTenant(db, tenantId, async (tx) => {
        await tx`UPDATE tenants SET goals = ${tx.array(g.data)}::text[], updated_at = now() WHERE id = ${tenantId}`;
        await auditVia(tx, ctx, "workspace.profile.update", "tenant", tenantId, { goals: g.data });
      });
      return { ok: true, reply: { ok: true, goals: g.data }, blocks: [{ type: "preview", title: "Goals updated", lines: g.data.length ? g.data : ["No goals"] }] };
    }
    case "update_agent_draft": {
      const id = uuid.safeParse(a.agentId);
      if (!id.success) return fail("agentId must be an agent id from the summary", "agentId");
      const patch = { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.config !== undefined ? { config: a.config } : {}) };
      if (!Object.keys(patch).length) return fail("Nothing to change");
      return withTenant(db, tenantId, async (tx): Promise<ToolResult> => {
        const repo = new AgentsRepository(tx, tenantId);
        const cur = await repo.get(id.data, true);
        if (!cur) return fail("Agent not found", "agentId");
        if (cur.status === "archived") return fail("This agent is archived");
        const r = applyPatch({ name: cur.name, description: cur.description, config: cur.config as unknown as Record<string, unknown>, knowledge: [], ready: false }, patch);
        if (!r.ok) return { ok: false, reply: { ok: false, errors: r.errors } };
        const parsed = agentConfigSchema.safeParse(r.draft.config);
        if (!parsed.success) return { ok: false, reply: { ok: false, errors: issues(parsed.error) } };
        const updated = await repo.update(id.data, { name: r.draft.name, description: r.draft.description, config: parsed.data });
        const changes: { field: string; before: string; after: string }[] = [];
        if (r.draft.name !== cur.name) changes.push({ field: "name", before: short(cur.name), after: short(r.draft.name) });
        if (r.draft.description !== cur.description) changes.push({ field: "description", before: short(cur.description), after: short(r.draft.description) });
        for (const k of Object.keys((patch.config ?? {}) as object) as (keyof AgentConfig)[]) {
          if (JSON.stringify(cur.config[k]) !== JSON.stringify(parsed.data[k])) changes.push({ field: k, before: short(cur.config[k]), after: short(parsed.data[k]) });
        }
        await auditVia(tx, ctx, "agent.updated", "agent", id.data, { fields: Object.keys(patch) });
        return {
          ok: true, reply: { ok: true, status: updated!.status, changed: changes.map((c) => c.field), note: "Draft updated. It is not live until published." },
          blocks: changes.length ? [{ type: "diff", title: `Updated ${updated!.name} (draft)`, changes }] : undefined,
        };
      });
    }
    case "publish_agent": {
      const id = uuid.safeParse(a.agentId);
      if (!id.success) return fail("agentId must be an agent id from the summary", "agentId");
      const note = typeof a.note === "string" ? a.note.slice(0, 500) : "";
      return withTenant(db, tenantId, async (tx): Promise<ToolResult> => {
        const cur = await new AgentsRepository(tx, tenantId).get(id.data);
        if (!cur) return fail("Agent not found", "agentId");
        if (cur.status === "archived") return fail("This agent is archived");
        const token = randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
        await tx`UPDATE copilot_pending_actions SET status = 'cancelled', resolved_at = now() WHERE tenant_id = ${tenantId} AND session_id = ${ctx.sessionId} AND status = 'pending'`;
        await tx`INSERT INTO copilot_pending_actions (tenant_id, session_id, user_id, kind, params, token_hash, expires_at)
          VALUES (${tenantId}, ${ctx.sessionId}, ${ctx.userId}, 'publish_agent', ${tx.json({ agentId: id.data, note } as never)}, ${hashToken(token)}, ${expiresAt})`;
        await auditVia(tx, ctx, "copilot.publish_proposed", "agent", id.data);
        // The token goes only into the UI block, never into the model's context.
        return {
          ok: true, reply: { ok: true, pending: true, note: "A confirmation card was shown to the owner. Tell them to press Confirm to publish; you cannot publish yourself." },
          blocks: [{ type: "confirm", token, title: `Publish ${cur.name}?`, summary: "Customers will start getting answers from the current draft.", expiresAt: expiresAt.toISOString() }],
        };
      });
    }
    case "update_widget_appearance": {
      const keys = ["title", "subtitle", "welcomeMessage", "primaryColor", "position", "launcherLabel", "theme", "inputPlaceholder"] as const;
      const patch: Record<string, unknown> = {};
      for (const k of keys) if (a[k] !== undefined) patch[k] = a[k];
      if (!Object.keys(patch).length) return fail("Nothing to change");
      return withTenant(db, tenantId, async (tx): Promise<ToolResult> => {
        const repo = new WidgetsRepository(tx, tenantId);
        let w;
        if (a.widgetId !== undefined) { const id = uuid.safeParse(a.widgetId); if (!id.success) return fail("widgetId must be a widget id from the summary", "widgetId"); w = await repo.get(id.data); }
        else w = (await repo.list())[0];
        if (!w) return fail("No widget found");
        const merged = widgetConfigSchema.safeParse({ ...(w.config ?? {}), ...patch });
        if (!merged.success) return { ok: false, reply: { ok: false, errors: issues(merged.error) } };
        await repo.update(w.id, { config: merged.data });
        const before = (w.config ?? {}) as Record<string, unknown>;
        await auditVia(tx, ctx, "widget.update", "widget", w.id, { fields: Object.keys(patch) });
        return {
          ok: true, reply: { ok: true, widgetId: w.id, changed: Object.keys(patch) },
          blocks: [{ type: "diff", title: `Updated ${w.name}`, changes: Object.keys(patch).map((k) => ({ field: k, before: short(before[k] ?? "(not set)"), after: short(patch[k]) })) }],
        };
      });
    }
    case "add_knowledge_url": {
      const p = z.object({ url: z.string().url().max(2048), depth: z.number().int().min(1).max(5).default(3), maxPages: z.number().int().min(1).max(25).default(25) }).safeParse(a);
      if (!p.success) return { ok: false, reply: { ok: false, errors: issues(p.error) } };
      try { await assertSafeUrl(p.data.url); } catch (e) { if (e instanceof SsrfError) return fail(e.message, "url"); throw e; }
      return withTenant(db, tenantId, async (tx): Promise<ToolResult> => {
        const [c] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ${tenantId} AND action = 'knowledge.source.create' AND metadata->>'sessionId' = ${ctx.sessionId}`;
        if (c!.n >= MAX_KNOWLEDGE_PER_SESSION) return fail(`At most ${MAX_KNOWLEDGE_PER_SESSION} websites per Ask Lumi session; the owner can add more under Knowledge.`);
        await assertWithinLimit(tx, tenantId, "storage_mb", 0);
        const src = await new KnowledgeRepository(tx, tenantId).create({
          type: "url", name: new URL(p.data.url).hostname, sourceUrl: p.data.url,
          crawlConfig: { maxPages: p.data.maxPages, followLinks: p.data.maxPages > 1, maxDepth: p.data.depth, includeSubdomains: false }, createdBy: ctx.userId,
        });
        await enqueue(tx, { name: "knowledge.ingest", tenantId, payload: { tenantId, sourceId: src.id }, maxAttempts: 4 });
        await auditVia(tx, ctx, "knowledge.source.create", "knowledge_source", src.id, { type: "url", name: src.name });
        return { ok: true, reply: { ok: true, status: "queued" }, blocks: [{ type: "preview", title: "Learning from your website", lines: [src.name, `Up to ${p.data.maxPages} pages, ${p.data.depth} levels deep`, "It appears under Knowledge when ready"] }] };
      });
    }
    case "set_business_hours": {
      const p = opsSettingsUpdateSchema.safeParse({ ...(a.timezone !== undefined ? { timezone: a.timezone } : {}), businessHours: a.days });
      if (!p.success) return { ok: false, reply: { ok: false, errors: issues(p.error) } };
      if (p.data.timezone && !validTz(p.data.timezone)) return fail("Unknown IANA timezone", "timezone");
      for (const [i, h] of (p.data.businessHours ?? []).entries()) if (minutes(h.start) >= minutes(h.end)) return fail("start must be before end", `days.${i}`);
      await withTenant(db, tenantId, async (tx) => {
        await saveOpsSettings(tx, tenantId, p.data);
        await auditVia(tx, ctx, "ops_settings.update", "ops_settings", tenantId, { fields: Object.keys(p.data) });
      });
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return { ok: true, reply: { ok: true }, blocks: [{ type: "preview", title: "Business hours saved", lines: (p.data.businessHours ?? []).map((h) => `${names[h.weekday]} ${h.start}-${h.end}`) }] };
    }
    default:
      return fail(`Unknown tool ${name}`);
  }
}
