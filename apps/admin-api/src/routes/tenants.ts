// Customers: list/search/export, Customer 360 reads, lifecycle, plan, credits, flags.
import { z } from "zod";
import { emailSchema, passwordSchema } from "@yulona/shared";
import type { Deps } from "../context";
import { creditsDto, type CreditsRowRaw } from "../credits";
import { normalizeDates } from "../dates";
import { Errors } from "../errors";
import { isFkViolation, isUniqueViolation, iso, pageTotal, parseBody, parseId, parseQuery, toCsv } from "../http";
import { ALL, OWNER, OWNER_BILLING, type Registrar } from "../route";
import { hashPassword } from "../security";

export const planKey = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
export const flagKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
export const tagSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,29}$/);
const HEALTH = ["healthy", "watch", "at_risk"] as const;
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

export const tenantListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  plan: planKey.optional(),
  health: z.enum(HEALTH).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  inactiveDays: z.coerce.number().int().min(1).max(3650).optional(),
  hasErrors: bool.optional(),
  credits: z.enum(["ok", "low", "exhausted", "unlimited"]).optional(),
  tag: tagSchema.optional(),
  sort: z.enum(["createdAt", "name", "health", "lastActive", "credits", "errors"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type ListQuery = z.output<typeof tenantListQuery>;

interface ListRow {
  id: string; name: string; status: string; planKey: string; deletedAt: Date | null; createdAt: Date; userCount: string; ownerEmail: string | null;
  lastActiveAt: Date | null; errorCount7d: number; creditsState: string; creditsRemainingMicro: string | null; healthScore: number; healthBucket: string;
  healthReasons: unknown[]; tags: string[]; total: string;
}
const item = (r: ListRow) => ({
  id: r.id, name: r.name, status: r.status, plan: r.planKey, createdAt: iso(r.createdAt), deletedAt: iso(r.deletedAt), userCount: Number(r.userCount),
  ownerEmail: r.ownerEmail, lastActiveAt: iso(r.lastActiveAt), errorCount7d: r.errorCount7d,
  credits: { state: r.creditsState, remainingMicro: r.creditsRemainingMicro === null ? null : Number(r.creditsRemainingMicro) },
  health: { score: r.healthScore, bucket: r.healthBucket, reasons: r.healthReasons }, tags: r.tags,
});

export const ERROR_HINTS: Record<string, string> = {
  job_failed: "A background task used all its retries. Read the error, fix the cause (credentials, provider, data), then retry or discard it under Operations.",
  webhook_delivery_failed: "The customer's endpoint failed or timed out. Ask them to check the URL, certificate and that it answers 2xx within a few seconds.",
  channel_error: "The channel provider rejected the stored credentials or webhook. Ask the customer to reconnect the channel in Channels.",
  channel_delivery_failed: "A reply could not be delivered on the channel (expired window, blocked user or revoked token). Check the channel connection health.",
  knowledge_ingest_failed: "A knowledge source could not be read (blocked URL, unsupported file, empty page). Ask the customer to re-upload or fix the source.",
  notification_email_failed: "A notification email bounced or the mail provider is failing. Check the email provider settings and the recipient address.",
  crm_sync_failed: "The CRM rejected a sync (expired token or missing permission). Ask the customer to reconnect the integration.",
  handoff_system_failure: "The AI could not answer and handed the conversation to a person. Common causes: credits exhausted, provider outage, tool failure.",
  abuse_handoff: "The AI flagged a conversation as abusive. No action needed unless the customer asks.",
  tool_failed: "A custom tool call failed. Check the tool's connection, URL and credentials in the customer's Tools settings.",
};
const KINDS = Object.keys(ERROR_HINTS) as [string, ...string[]];

const stamp = () => new Date().toISOString().slice(0, 10);
const csvHeaders = (name: string) => ({ "Cache-Control": "no-store", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}-${stamp()}.csv"` });

export function registerTenantRoutes(reg: Registrar, d: Deps) {
  const { cfg, db } = d;
  const listArgs = (q: ListQuery, limit: number, offset: number) => db<ListRow[]>`
    SELECT * FROM sa_list_tenants_v2(${q.q ?? null}, ${q.status ?? null}, ${q.plan ?? null}, ${q.health ?? null}, ${q.createdFrom ?? null}, ${q.createdTo ?? null},
      ${q.inactiveDays ?? null}, ${q.hasErrors ?? null}, ${q.credits ?? null}, ${q.tag ?? null}, ${q.sort}, ${q.order}, ${limit}, ${offset})`;
  const exists = async (id: string) => {
    const [t] = await db`SELECT id FROM sa_get_tenant(${id})`;
    if (!t) throw Errors.notFound("Tenant not found");
  };
  const readAudit = (adminId: string, action: string, tenantId: string | null) => db`SELECT sa_audit_read(${adminId}, ${action}, ${tenantId}, 10)`;
  const tenantCredits = async (tenantId: string) => {
    const [row] = await db<(CreditsRowRaw & { planKey: string })[]>`
      SELECT plan_key, to_char(period, 'YYYY-MM-DD') AS period, allowance_micro, used_micro, topup_micro, topup_used_micro FROM sa_tenant_credits(${tenantId}::uuid)`;
    if (!row) throw Errors.notFound("Tenant not found");
    return { ...creditsDto(cfg.deploymentMode, row), planKey: row.planKey };
  };
  const limitsOf = async (id: string) => (await db<{ metric: string; limitValue: string | null; used: string; warning: boolean }[]>`SELECT * FROM sa_tenant_limits(${id})`)
    .map((l) => ({ metric: l.metric, limit: l.limitValue === null ? null : Number(l.limitValue), used: Number(l.used), warning: l.warning }));
  const summary = (t: { id: string; name: string; status: string; planKey: string; deletedAt: Date | null }) => ({ id: t.id, name: t.name, status: t.status, plan: t.planKey, deletedAt: iso(t.deletedAt) });

  // ---------------------------------------------------------------- list / export
  reg.route({ method: "GET", path: "/tenants", roles: ALL, tag: "Customers", summary: "Search, filter and sort customers (server side)", query: tenantListQuery }, async (c) => {
    const q = parseQuery(c, tenantListQuery);
    const rows = await listArgs(q, q.limit, q.offset);
    return c.json({ items: rows.map(item), total: await pageTotal(rows, q.offset, () => listArgs(q, 1, 0)), limit: q.limit, offset: q.offset });
  });
  reg.route({ method: "GET", path: "/tenants/export", roles: ALL, tag: "Customers", summary: "CSV export of the filtered customer list (audited)", query: tenantListQuery, write: true, contentType: "text/csv" }, async (c) => {
    const q = parseQuery(c, tenantListQuery);
    const rows = await listArgs(q, 20000, 0);
    await db`SELECT sa_audit_event(${c.get("admin").id}, 'customers.export', NULL, ${db.json({ rows: rows.length } as never)})`;
    const body = toCsv(["id", "name", "status", "plan", "createdAt", "ownerEmail", "userCount", "lastActiveAt", "healthScore", "healthBucket", "errorCount7d", "creditsState", "tags"],
      rows.map((r) => [r.id, r.name, r.status, r.planKey, r.createdAt, r.ownerEmail, r.userCount, r.lastActiveAt, r.healthScore, r.healthBucket, r.errorCount7d, r.creditsState, r.tags.join(" ")]));
    return new Response(body, { headers: csvHeaders("customers") });
  });

  const createBody = z.strictObject({ name: z.string().trim().min(1).max(100), plan: planKey.default("free"), ownerEmail: emailSchema, ownerName: z.string().trim().min(1).max(100), ownerPassword: passwordSchema });
  reg.route({ method: "POST", path: "/tenants", roles: OWNER, tag: "Customers", summary: "Create a customer workspace with its owner", body: createBody, status: 201 }, async (c) => {
    const body = await parseBody(c, createBody);
    const hash = await hashPassword(body.ownerPassword);
    try {
      const [row] = await db<{ rTenantId: string; rUserId: string }[]>`
        SELECT * FROM sa_create_tenant(${c.get("admin").id}, ${body.name}, ${body.plan}, ${body.ownerEmail}, ${body.ownerName}, ${hash})`;
      return c.json({ id: row!.rTenantId, ownerUserId: row!.rUserId }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("Owner email is already registered");
      if (isFkViolation(e)) throw Errors.validation([{ path: "plan", message: "Unknown plan" }]);
      throw e;
    }
  });

  // ---------------------------------------------------------------- Customer 360
  reg.route({ method: "GET", path: "/tenants/:id", roles: ALL, tag: "Customer 360", summary: "Customer overview: health, counts, limits, billing, credits (audited tenant.view)" }, async (c) => {
    const id = parseId(c);
    const [o] = await db<{ saTenantOverview: Record<string, unknown> | null }[]>`SELECT sa_tenant_overview(${id})`;
    if (!o?.saTenantOverview) throw Errors.notFound("Tenant not found");
    await readAudit(c.get("admin").id, "tenant.view", id);
    const [limits, credits] = await Promise.all([limitsOf(id), tenantCredits(id)]);
    return c.json({ ...normalizeDates(o.saTenantOverview), limits, credits });
  });

  const patchBody = z.strictObject({ name: z.string().trim().min(1).max(100) });
  reg.route({ method: "PATCH", path: "/tenants/:id", roles: OWNER, tag: "Customers", summary: "Rename a customer", body: patchBody }, async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, patchBody);
    const [ok] = await db<{ saUpdateTenant: boolean }[]>`SELECT sa_update_tenant(${c.get("admin").id}, ${id}, ${body.name}, NULL)`;
    if (!ok?.saUpdateTenant) throw Errors.notFound("Tenant not found");
    const [t] = await db<{ id: string; name: string; status: string; planKey: string; deletedAt: Date | null }[]>`SELECT * FROM sa_get_tenant(${id})`;
    return c.json(summary(t!));
  });

  const planBody = z.strictObject({ plan: planKey });
  reg.route({ method: "PUT", path: "/tenants/:id/plan", roles: OWNER_BILLING, tag: "Customers", summary: "Change a customer's plan", body: planBody }, async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, planBody);
    try {
      const [ok] = await db<{ saUpdateTenant: boolean }[]>`SELECT sa_update_tenant(${c.get("admin").id}, ${id}, NULL, ${body.plan})`;
      if (!ok?.saUpdateTenant) throw Errors.notFound("Tenant not found");
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "plan", message: "Unknown plan" }]);
      throw e;
    }
    return c.json({ id, plan: body.plan });
  });

  const setStatus = (status: "active" | "suspended" | "deleted") => async (c: import("hono").Context<import("../route").AdminEnv>) => {
    const id = parseId(c);
    const [res] = await db<{ saSetTenantStatus: string }[]>`SELECT sa_set_tenant_status(${c.get("admin").id}, ${id}, ${status})`;
    if (res?.saSetTenantStatus === "not_found") throw Errors.notFound("Tenant not found");
    if (res?.saSetTenantStatus === "expired") throw Errors.conflict("Deletion grace period has passed");
    const [t] = await db<{ id: string; name: string; status: string; planKey: string; deletedAt: Date | null }[]>`SELECT * FROM sa_get_tenant(${id})`;
    return c.json(summary(t!));
  };
  reg.route({ method: "POST", path: "/tenants/:id/suspend", roles: OWNER, tag: "Customers", summary: "Suspend a customer (sessions revoked, access blocked at once)" }, setStatus("suspended"));
  reg.route({ method: "POST", path: "/tenants/:id/unsuspend", roles: OWNER, tag: "Customers", summary: "Lift a suspension" }, setStatus("active"));
  reg.route({ method: "POST", path: "/tenants/:id/restore", roles: OWNER, tag: "Customers", summary: "Restore a deleted customer within the 30-day grace period" }, setStatus("active"));
  reg.route({ method: "DELETE", path: "/tenants/:id", roles: OWNER, tag: "Customers", summary: "Soft-delete a customer (purged after 30 days)" }, setStatus("deleted"));

  // ---- team
  reg.route({ method: "GET", path: "/tenants/:id/users", roles: ALL, tag: "Customer 360", summary: "Team members and invitations of a customer" }, async (c) => {
    const id = parseId(c);
    await exists(id);
    const [users, invitations] = await Promise.all([
      db<{ id: string; email: string; name: string; role: string; status: string; lastLoginAt: Date | null; createdAt: Date; locked: boolean }[]>`SELECT * FROM sa_tenant_users(${id})`,
      db<{ id: string; email: string; role: string; createdAt: Date; expiresAt: Date; status: string }[]>`SELECT * FROM sa_tenant_invitations(${id})`,
    ]);
    return c.json({
      items: users.map((u) => ({ ...u, lastLoginAt: iso(u.lastLoginAt), createdAt: iso(u.createdAt) })),
      invitations: invitations.map((i) => ({ ...i, createdAt: iso(i.createdAt), expiresAt: iso(i.expiresAt) })),
    });
  });

  // ---- timeline
  const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
  const timelineQ = pageQ.extend({ source: z.enum(["tenant_audit", "platform_audit", "billing", "handoff", "impersonation"]).optional() });
  reg.route({ method: "GET", path: "/tenants/:id/timeline", roles: ALL, tag: "Customer 360", summary: "Merged timeline (tenant audit, platform audit, billing, handoffs, impersonation); no message text", query: timelineQ }, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, timelineQ);
    await exists(id);
    const fetchTl = (limit: number, offset: number) => db<{ at: Date; source: string; action: string; actor: string; resourceType: string | null; resourceId: string | null; detail: unknown; total: string }[]>`
      SELECT * FROM sa_tenant_timeline(${id}, ${q.source ?? null}, ${limit}, ${offset})`;
    const rows = await fetchTl(q.limit, q.offset);
    return c.json({
      items: rows.map((r) => ({ at: iso(r.at), source: r.source, action: r.action, actor: r.actor, resourceType: r.resourceType, resourceId: r.resourceId, detail: normalizeDates(r.detail) })),
      total: await pageTotal(rows, q.offset, () => fetchTl(1, 0)), limit: q.limit, offset: q.offset,
    });
  });

  // ---- errors
  const errQ = pageQ.extend({ kind: z.enum(KINDS).optional(), days: z.coerce.number().int().min(1).max(90).default(7) });
  const errRows = (id: string, q: { kind?: string; days: number }, limit: number, offset: number) => db<{ kind: string; at: Date; refId: string; title: string; detail: string; total: string }[]>`
    SELECT * FROM sa_tenant_errors(${id}, ${q.kind ?? null}, ${q.days}, ${limit}, ${offset})`;
  reg.route({ method: "GET", path: "/tenants/:id/errors", roles: ALL, tag: "Customer 360", summary: "Failures of a customer: jobs, webhooks, channels, ingests, emails, CRM, handoffs, tools", query: errQ }, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, errQ);
    await exists(id);
    const [rows, counts] = await Promise.all([
      errRows(id, q, q.limit, q.offset),
      db<{ kind: string; n: string }[]>`SELECT * FROM sa_tenant_error_counts(${id}, ${q.days})`,
    ]);
    return c.json({
      items: rows.map((r) => ({ kind: r.kind, at: iso(r.at), refId: r.refId, title: r.title, detail: r.detail, hint: ERROR_HINTS[r.kind] ?? "" })),
      total: await pageTotal(rows, q.offset, () => errRows(id, q, 1, 0)), counts: Object.fromEntries(counts.map((x) => [x.kind, Number(x.n)])), limit: q.limit, offset: q.offset,
    });
  });
  reg.route({ method: "GET", path: "/tenants/:id/errors/export", roles: ALL, tag: "Customer 360", summary: "CSV export of a customer's failures (audited)", query: errQ.omit({ limit: true, offset: true }), write: true, contentType: "text/csv" }, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, errQ);
    await exists(id);
    const rows = await errRows(id, q, 20000, 0);
    await db`SELECT sa_audit_event(${c.get("admin").id}, 'errors.export', ${id}, ${db.json({ rows: rows.length } as never)})`;
    return new Response(toCsv(["kind", "at", "refId", "title", "detail"], rows.map((r) => [r.kind, r.at, r.refId, r.title, r.detail])), { headers: csvHeaders("errors") });
  });

  // ---- assets, billing, usage
  reg.route({ method: "GET", path: "/tenants/:id/assets", roles: ALL, tag: "Customer 360", summary: "Agents, widgets, channels, knowledge, connections, webhooks, calendar and CRM with status (no secrets)" }, async (c) => {
    const [a] = await db<{ saTenantAssets: unknown }[]>`SELECT sa_tenant_assets(${parseId(c)})`;
    if (!a?.saTenantAssets) throw Errors.notFound("Tenant not found");
    return c.json(normalizeDates(a.saTenantAssets));
  });
  reg.route({ method: "GET", path: "/tenants/:id/billing", roles: ALL, tag: "Customer 360", summary: "Plan, subscription, billing events and credit top-ups" }, async (c) => {
    const [b] = await db<{ saTenantBilling: unknown }[]>`SELECT sa_tenant_billing(${parseId(c)})`;
    if (!b?.saTenantBilling) throw Errors.notFound("Tenant not found");
    return c.json(normalizeDates(b.saTenantBilling));
  });
  const daysQ = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
  reg.route({ method: "GET", path: "/tenants/:id/ai-usage", roles: ALL, tag: "Customer 360", summary: "AI usage by day, model and source", query: daysQ }, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, daysQ);
    await exists(id);
    const rows = await db<{ day: Date; model: string; source: string; requests: string; promptTokens: string; completionTokens: string; creditsMicro: string }[]>`SELECT * FROM sa_tenant_ai_usage(${id}, ${q.days})`;
    const series = rows.map((r) => ({ day: iso(r.day)!.slice(0, 10), model: r.model, source: r.source, requests: Number(r.requests), promptTokens: Number(r.promptTokens), completionTokens: Number(r.completionTokens), creditsMicro: Number(r.creditsMicro) }));
    const sum = (k: "requests" | "promptTokens" | "completionTokens" | "creditsMicro") => series.reduce((n, r) => n + r[k], 0);
    return c.json({ series, totals: { requests: sum("requests"), promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), creditsMicro: sum("creditsMicro") } });
  });
  reg.route({ method: "GET", path: "/tenants/:id/usage", roles: ALL, tag: "Customer 360", summary: "Daily usage rollup and plan limits", query: daysQ }, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, daysQ);
    await exists(id);
    const rows = await db<{ day: Date; metric: string; value: string }[]>`SELECT * FROM sa_tenant_usage(${id}, ${q.days})`;
    return c.json({ series: rows.map((x) => ({ day: iso(x.day)!.slice(0, 10), metric: x.metric, value: Number(x.value) })), limits: await limitsOf(id) });
  });

  // ---- credits
  reg.route({ method: "GET", path: "/tenants/:id/credits", roles: ALL, tag: "Customer 360", summary: "Credits for the current period" }, async (c) => c.json(await tenantCredits(parseId(c))));
  const grantBody = z.strictObject({
    credits: z.number().finite().refine((v) => v !== 0, "Must not be zero").refine((v) => Math.abs(v) <= 10_000_000, "Too large"),
    reason: z.string().trim().min(3).max(300),
  });
  reg.route({ method: "POST", path: "/tenants/:id/credits", roles: OWNER_BILLING, tag: "Customer 360", summary: "Grant or adjust (negative) credits with a reason", body: grantBody }, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, grantBody);
    const [res] = await db<{ saGrantCredits: boolean }[]>`SELECT sa_grant_credits(${c.get("admin").id}, ${id}, ${Math.round(b.credits * 1_000_000)}, ${b.reason})`;
    if (!res?.saGrantCredits) throw Errors.notFound("Tenant not found");
    return c.json(await tenantCredits(id));
  });

  // ---- flags
  reg.route({ method: "GET", path: "/tenants/:id/flags", roles: ALL, tag: "Customer 360", summary: "Feature flags with this customer's overrides" }, async (c) => {
    const id = parseId(c);
    await exists(id);
    const [flags, overrides] = await Promise.all([
      db<{ key: string; defaultEnabled: boolean }[]>`SELECT key, default_enabled FROM sa_list_flags()`,
      db<{ flagKey: string; enabled: boolean }[]>`SELECT * FROM sa_tenant_flag_overrides(${id})`,
    ]);
    const o = new Map(overrides.map((x) => [x.flagKey, x.enabled]));
    return c.json({ items: flags.map((f) => ({ key: f.key, defaultEnabled: f.defaultEnabled, override: o.get(f.key) ?? null, effective: o.get(f.key) ?? f.defaultEnabled })) });
  });
  const flagBody = z.strictObject({ enabled: z.boolean().nullable() });
  reg.route({ method: "PUT", path: "/tenants/:id/flags/:key", roles: OWNER, tag: "Customer 360", summary: "Set or clear (null) a per-customer flag override", body: flagBody }, async (c) => {
    const id = parseId(c);
    const key = flagKeySchema.safeParse(c.req.param("key"));
    if (!key.success) throw Errors.notFound();
    const body = await parseBody(c, flagBody);
    const [x] = await db<{ saSetTenantFlag: boolean }[]>`SELECT sa_set_tenant_flag(${c.get("admin").id}, ${id}, ${key.data}, ${body.enabled})`;
    if (!x?.saSetTenantFlag) throw Errors.notFound("Tenant or flag not found");
    return c.json({ key: key.data, override: body.enabled });
  });
}
