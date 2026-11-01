// Overview, search, needs-attention queue, platform health, operations (dead jobs, failed webhooks) and the audit log.
import { z } from "zod";
import type { Deps } from "../context";
import { normalizeDates } from "../dates";
import { Errors } from "../errors";
import { iso, pageTotal, parseId, parseQuery, toCsv } from "../http";
import { ALL, OWNER, OWNER_SUPPORT, type Registrar } from "../route";

interface AttentionRow {
  id: string; name: string; status: string; planKey: string; ownerEmail: string | null; lastActiveAt: Date | null; errorCount7d: number;
  healthScore: number; healthBucket: string; healthReasons: unknown[]; total: string;
}
const attentionDto = (r: AttentionRow) => ({
  id: r.id, name: r.name, plan: r.planKey, status: r.status, health: { score: r.healthScore, bucket: r.healthBucket, reasons: r.healthReasons },
  ownerEmail: r.ownerEmail, errorCount7d: r.errorCount7d, lastActiveAt: iso(r.lastActiveAt),
});
const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

export function registerOpsRoutes(reg: Registrar, d: Deps) {
  const { db } = d;

  const attention = (limit: number, offset: number) => db<AttentionRow[]>`SELECT * FROM sa_attention(${limit}, ${offset})`;

  reg.route({ method: "GET", path: "/overview", roles: ALL, tag: "Overview", summary: "KPIs with previous-period deltas, health buckets, 30-day series and the top needs-attention list" }, async (c) => {
    const [[o], top] = await Promise.all([db<{ saOverview: Record<string, unknown> }[]>`SELECT sa_overview()`, attention(10, 0)]);
    return c.json({ ...normalizeDates(o!.saOverview), attention: top.map(attentionDto) });
  });

  reg.route({ method: "GET", path: "/analytics", roles: ALL, tag: "Overview", summary: "Platform analytics (tenants, plans, MRR, conversations, funnel)" }, async (c) => {
    const [a] = await db<{ saPlatformAnalytics: Record<string, unknown> }[]>`SELECT sa_platform_analytics()`;
    return c.json(a!.saPlatformAnalytics);
  });

  reg.route({ method: "GET", path: "/health", roles: ALL, tag: "Overview", summary: "Platform health: database, queue, worker heartbeat" }, async (c) => {
    const t0 = performance.now();
    let dbOk = true;
    try { await db`SELECT 1`; } catch { dbOk = false; }
    const latencyMs = Math.round(performance.now() - t0);
    let queue = { queued: 0, running: 0, dead: 0, oldestQueuedAgeSec: null as number | null };
    let hb: { lastHeartbeatAt: string | null; heartbeatAgeSec: number | null } = { lastHeartbeatAt: null, heartbeatAgeSec: null };
    if (dbOk) {
      const [h] = await db<{ saSystemHealth: { queue: typeof queue; lastHeartbeatAt: string | null; heartbeatAgeSec: number | null } }[]>`SELECT sa_system_health()`;
      queue = h!.saSystemHealth.queue;
      hb = h!.saSystemHealth;
    }
    const workerOk = hb.heartbeatAgeSec !== null && hb.heartbeatAgeSec < 120;
    const status = !dbOk ? "down" : !workerOk || queue.dead > 0 ? "degraded" : "ok";
    return c.json({
      status, db: { ok: dbOk, latencyMs },
      queue: { queued: Number(queue.queued), running: Number(queue.running), dead: Number(queue.dead), oldestQueuedAgeSec: queue.oldestQueuedAgeSec },
      worker: { lastHeartbeatAt: hb.lastHeartbeatAt ? new Date(hb.lastHeartbeatAt).toISOString() : null, ageSec: hb.heartbeatAgeSec, ok: workerOk },
    });
  });

  const searchQ = z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(25).default(10) });
  reg.route({ method: "GET", path: "/search", roles: ALL, tag: "Overview", summary: "Command-palette search: customers by name, id or member email; users by email", query: searchQ }, async (c) => {
    const q = parseQuery(c, searchQ);
    const rows = await db<{ kind: string; tenantId: string; tenantName: string; id: string; label: string; sublabel: string | null; status: string; planKey: string; matchedOn: string; role: string | null }[]>`
      SELECT * FROM sa_search(${q.q}, ${q.limit})`;
    return c.json({
      tenants: rows.filter((r) => r.kind === "tenant").map((r) => ({ id: r.id, name: r.label, status: r.status, plan: r.planKey, matchedOn: r.matchedOn })),
      users: rows.filter((r) => r.kind === "user").map((r) => ({ id: r.id, tenantId: r.tenantId, tenantName: r.tenantName, email: r.label, name: r.sublabel, role: r.role, status: r.status })),
    });
  });

  reg.route({ method: "GET", path: "/attention", roles: ALL, tag: "Overview", summary: "Needs-attention queue: active customers that are watch or at risk, worst first", query: pageQ }, async (c) => {
    const q = parseQuery(c, pageQ);
    const rows = await attention(q.limit, q.offset);
    return c.json({ items: rows.map(attentionDto), total: await pageTotal(rows, q.offset, () => attention(1, 0)), limit: q.limit, offset: q.offset });
  });

  // ---------------------------------------------------------------- operations
  const opsQ = pageQ.extend({ tenantId: z.uuid().optional() });
  reg.route({ method: "GET", path: "/ops/dead-jobs", roles: ALL, tag: "Operations", summary: "Dead background jobs (payload never returned)", query: opsQ }, async (c) => {
    const q = parseQuery(c, opsQ);
    const fetchJobs = (limit: number, offset: number) => db<{ id: string; tenantId: string; tenantName: string; name: string; attempts: number; maxAttempts: number; lastError: string; createdAt: Date; updatedAt: Date; total: string }[]>`
      SELECT * FROM sa_dead_jobs(${q.tenantId ?? null}, ${limit}, ${offset})`;
    const rows = await fetchJobs(q.limit, q.offset);
    return c.json({
      items: rows.map((r) => ({ id: r.id, tenantId: r.tenantId, tenantName: r.tenantName, name: r.name, attempts: r.attempts, maxAttempts: r.maxAttempts, lastError: r.lastError, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })),
      total: await pageTotal(rows, q.offset, () => fetchJobs(1, 0)), limit: q.limit, offset: q.offset,
    });
  });
  reg.route({ method: "POST", path: "/ops/dead-jobs/:id/retry", roles: OWNER_SUPPORT, tag: "Operations", summary: "Requeue a dead job (attempts reset)" }, async (c) => {
    const [r] = await db<{ saDeadJobRetry: boolean }[]>`SELECT sa_dead_job_retry(${c.get("admin").id}, ${parseId(c)})`;
    if (!r?.saDeadJobRetry) throw Errors.notFound("Dead job not found");
    return c.json({ ok: true as const });
  });
  reg.route({ method: "POST", path: "/ops/dead-jobs/:id/discard", roles: OWNER_SUPPORT, tag: "Operations", summary: "Delete a dead job" }, async (c) => {
    const [r] = await db<{ saDeadJobDiscard: boolean }[]>`SELECT sa_dead_job_discard(${c.get("admin").id}, ${parseId(c)})`;
    if (!r?.saDeadJobDiscard) throw Errors.notFound("Dead job not found");
    return c.json({ ok: true as const });
  });
  reg.route({ method: "GET", path: "/ops/failed-webhooks", roles: ALL, tag: "Operations", summary: "Failed customer webhook deliveries", query: opsQ }, async (c) => {
    const q = parseQuery(c, opsQ);
    const fetchWh = (limit: number, offset: number) => db<{ id: string; tenantId: string; tenantName: string; webhookId: string; webhookName: string; eventType: string; status: string; attempts: number; responseStatus: number | null; lastError: string; createdAt: Date; completedAt: Date | null; total: string }[]>`
      SELECT * FROM sa_failed_webhooks(${q.tenantId ?? null}, ${limit}, ${offset})`;
    const rows = await fetchWh(q.limit, q.offset);
    return c.json({
      items: rows.map((r) => ({ id: r.id, tenantId: r.tenantId, tenantName: r.tenantName, webhookId: r.webhookId, webhookName: r.webhookName, eventType: r.eventType, status: r.status,
        attempts: r.attempts, responseStatus: r.responseStatus, lastError: r.lastError, createdAt: iso(r.createdAt), completedAt: iso(r.completedAt) })),
      total: await pageTotal(rows, q.offset, () => fetchWh(1, 0)), limit: q.limit, offset: q.offset,
    });
  });

  // ---------------------------------------------------------------- audit log
  const auditFilters = z.object({
    adminId: z.uuid().optional(), tenantId: z.uuid().optional(), action: z.string().trim().min(1).max(80).optional(),
    from: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(), to: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  });
  const auditQ = auditFilters.extend(pageQ.shape);
  interface AuditRow { id: string; adminId: string | null; adminEmail: string | null; action: string; tenantId: string | null; tenantName: string | null; metadata: unknown; createdAt: Date; total: string }
  const auditRows = (q: z.output<typeof auditFilters>, limit: number, offset: number) => db<AuditRow[]>`
    SELECT * FROM sa_list_platform_audit_v2(${q.adminId ?? null}, ${q.tenantId ?? null}, ${q.action ?? null},
      ${q.from ? new Date(q.from) : null}, ${q.to ? new Date(q.to) : null}, ${limit}, ${offset})`;
  const auditDto = (r: AuditRow) => ({ id: r.id, adminId: r.adminId, adminEmail: r.adminEmail, action: r.action, tenantId: r.tenantId, tenantName: r.tenantName, metadata: r.metadata, createdAt: iso(r.createdAt) });

  reg.route({ method: "GET", path: "/audit-logs", roles: ALL, tag: "Audit", summary: "Platform audit log with filters (admin, customer, action or action prefix ending in '.', dates)", query: auditQ }, async (c) => {
    const q = parseQuery(c, auditQ);
    const rows = await auditRows(q, q.limit, q.offset);
    return c.json({ items: rows.map(auditDto), total: await pageTotal(rows, q.offset, () => auditRows(q, 1, 0)), limit: q.limit, offset: q.offset });
  });
  const exportQ = auditFilters.extend({ format: z.enum(["csv", "json"]).default("csv") });
  reg.route({ method: "GET", path: "/audit-logs/export", roles: OWNER, tag: "Audit", summary: "Export the filtered audit log (CSV or JSON, audited)", query: exportQ, write: true, contentType: "text/csv" }, async (c) => {
    const q = parseQuery(c, exportQ);
    const rows = await auditRows(q, 50000, 0);
    await db`SELECT sa_audit_event(${c.get("admin").id}, 'audit.export', ${q.tenantId ?? null}, ${db.json({ rows: rows.length, format: q.format } as never)})`;
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="platform-audit-${stamp}.${q.format}"` };
    if (q.format === "json") return new Response(JSON.stringify({ items: rows.map(auditDto) }), { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    return new Response(toCsv(["id", "createdAt", "adminId", "adminEmail", "action", "tenantId", "tenantName", "metadata"],
      rows.map((r) => [r.id, r.createdAt, r.adminId, r.adminEmail, r.action, r.tenantId, r.tenantName, r.metadata])), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  });
}
