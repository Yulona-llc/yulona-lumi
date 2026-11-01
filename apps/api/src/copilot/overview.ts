import { Hono } from "hono";
import { withTenant, type Db, type Tx } from "@yulona/db";
import type { Goal, OverviewDto } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { guard } from "../ops/common";
import { loadCredits } from "../usage/credits";

const since = (tx: Tx) => tx`now() - interval '30 days'`;
const n = (v: unknown) => Number(v ?? 0);

async function common(tx: Tx, tenantId: string, cfg: Config): Promise<OverviewDto["common"]> {
  const [c] = await tx<{ last30d: number; open: number; today: number }[]>`
    SELECT count(*) FILTER (WHERE created_at >= ${since(tx)})::int AS last30d,
           count(*) FILTER (WHERE status IN ('open','pending_human'))::int AS open,
           count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS today
    FROM conversations WHERE tenant_id = ${tenantId}`;
  const [ch] = await tx<{ total: number; connected: number; unhealthy: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS connected,
           count(*) FILTER (WHERE status = 'error' OR last_health_ok = false)::int AS unhealthy
    FROM channel_connections WHERE tenant_id = ${tenantId}`;
  const [s] = await tx<{ agents: number; published: number; ready: number; widgets: number }[]>`
    SELECT (SELECT count(*)::int FROM agents WHERE tenant_id = ${tenantId} AND status <> 'archived') AS agents,
           (SELECT count(*)::int FROM agents WHERE tenant_id = ${tenantId} AND status = 'published') AS published,
           (SELECT count(*)::int FROM knowledge_sources WHERE tenant_id = ${tenantId} AND status = 'ready') AS ready,
           (SELECT count(*)::int FROM widgets WHERE tenant_id = ${tenantId} AND enabled) AS widgets`;
  const credits = await loadCredits(tx, tenantId, cfg.deploymentMode);
  const items = [
    { key: "agent", label: "Create your agent", done: s!.agents > 0, path: "/agents" },
    { key: "knowledge", label: "Add knowledge", done: s!.ready > 0, path: "/knowledge" },
    { key: "channel", label: "Add the chat to your website or connect a channel", done: s!.widgets + ch!.total > 0, path: "/channels" },
    { key: "publish", label: "Try it, then publish your agent", done: s!.published > 0, path: "/agents" },
  ];
  return {
    conversations: { last30d: c!.last30d, open: c!.open, today: c!.today },
    credits: { remainingMicro: credits.remainingMicro, allowanceMicro: credits.allowanceMicro },
    channels: { total: ch!.total, connected: ch!.connected, unhealthy: ch!.unhealthy },
    setup: { items, doneCount: items.filter((i) => i.done).length, total: items.length },
  };
}

async function support(tx: Tx, tenantId: string): Promise<NonNullable<OverviewDto["support"]>> {
  const [r] = await tx<{ engaged: number; withHandoff: number; handoffs: number; median: number | null }[]>`
    WITH conv AS (SELECT id FROM conversations WHERE tenant_id = ${tenantId} AND created_at >= ${since(tx)} AND last_customer_message_at IS NOT NULL),
    h AS (SELECT DISTINCT conversation_id FROM handoffs WHERE tenant_id = ${tenantId} AND created_at >= ${since(tx)} AND conversation_id IS NOT NULL),
    fr AS (
      SELECT extract(epoch FROM (reply.at - first_msg.at)) AS secs
      FROM conv
      JOIN LATERAL (SELECT created_at AS at FROM messages WHERE tenant_id = ${tenantId} AND conversation_id = conv.id AND sender_type = 'contact' ORDER BY created_at LIMIT 1) first_msg ON true
      JOIN LATERAL (SELECT created_at AS at FROM messages m WHERE tenant_id = ${tenantId} AND conversation_id = conv.id AND sender_type IN ('ai','human') AND m.created_at >= first_msg.at ORDER BY created_at LIMIT 1) reply ON true
    )
    SELECT (SELECT count(*)::int FROM conv) AS engaged,
           (SELECT count(*)::int FROM conv WHERE id IN (SELECT conversation_id FROM h)) AS with_handoff,
           (SELECT count(*)::int FROM handoffs WHERE tenant_id = ${tenantId} AND created_at >= ${since(tx)}) AS handoffs,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM fr) AS median`;
  const un = await tx<{ id: string; conversationId: string | null; createdAt: Date }[]>`
    SELECT id, conversation_id, created_at FROM handoffs WHERE tenant_id = ${tenantId} AND type = 'uncertainty' AND created_at >= ${since(tx)} ORDER BY created_at DESC LIMIT 5`;
  const [uc] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM handoffs WHERE tenant_id = ${tenantId} AND type = 'uncertainty' AND created_at >= ${since(tx)}`;
  return {
    aiResolvedPct: r!.engaged ? Math.round(((r!.engaged - r!.withHandoff) * 1000) / r!.engaged) / 10 : null,
    handoffs: r!.handoffs,
    medianFirstResponseSeconds: r!.median === null ? null : Math.round(n(r!.median)),
    unanswered: { count: uc!.n, items: un.map((u) => ({ id: u.id, conversationId: u.conversationId, createdAt: u.createdAt.toISOString() })) },
  };
}

async function leads(tx: Tx, tenantId: string): Promise<NonNullable<OverviewDto["leads"]>> {
  const [s] = await tx<{ started: number }[]>`SELECT count(*)::int AS started FROM conversations WHERE tenant_id = ${tenantId} AND created_at >= ${since(tx)}`;
  const st = await tx<{ stage: string; n: number }[]>`
    SELECT to_stage AS stage, count(DISTINCT conversation_id)::int AS n FROM stage_transitions
    WHERE tenant_id = ${tenantId} AND created_at >= ${since(tx)} AND to_stage IN ('engaged','qualified','booking_offered','booked') GROUP BY to_stage`;
  const by = new Map(st.map((x) => [x.stage, x.n]));
  const funnel = [
    { stage: "visitor", count: s!.started },
    ...(["engaged", "qualified", "booking_offered", "booked"] as const).map((k) => ({ stage: k, count: by.get(k) ?? 0 })),
  ];
  const [h] = await tx<{ status: string | null; lastSyncAt: Date | null }[]>`SELECT status, last_sync_at FROM crm_connections WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
  const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM crm_sync_log WHERE tenant_id = ${tenantId} AND status = 'failed' AND created_at >= ${since(tx)}`;
  return {
    funnel, qualified: by.get("qualified") ?? 0,
    hubspot: { connected: !!h && h.status === "active", lastSyncAt: h?.lastSyncAt ? h.lastSyncAt.toISOString() : null, failed: f!.n },
  };
}

async function bookings(tx: Tx, tenantId: string): Promise<NonNullable<OverviewDto["bookings"]>> {
  const [b] = await tx<{ upcoming: number; booked: number; cancelled: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'booked' AND start_at > now())::int AS upcoming,
           count(*) FILTER (WHERE status = 'booked' AND created_at >= ${since(tx)})::int AS booked,
           count(*) FILTER (WHERE status = 'cancelled' AND COALESCE(cancelled_at, updated_at) >= ${since(tx)})::int AS cancelled
    FROM bookings WHERE tenant_id = ${tenantId}`;
  const [c] = await tx<{ provider: string }[]>`SELECT provider FROM calendar_connections WHERE tenant_id = ${tenantId} AND status = 'active' ORDER BY is_default DESC, provider LIMIT 1`;
  return { upcoming: b!.upcoming, booked30d: b!.booked, cancelled30d: b!.cancelled, calendar: { connected: !!c, provider: c?.provider ?? null } };
}

export async function loadOverview(tx: Tx, tenantId: string, cfg: Config): Promise<OverviewDto> {
  const [t] = await tx<{ goals: Goal[] }[]>`SELECT goals FROM tenants WHERE id = ${tenantId}`;
  const goals = t?.goals ?? [];
  const order = goals.filter((g) => g !== "other");
  const out: OverviewDto = { goals, order, common: await common(tx, tenantId, cfg) };
  if (goals.includes("support")) out.support = await support(tx, tenantId);
  if (goals.includes("leads")) out.leads = await leads(tx, tenantId);
  if (goals.includes("bookings")) out.bookings = await bookings(tx, tenantId);
  return out;
}

export function overviewRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.get("/overview", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(await withTenant(db, tenantId, (tx) => loadOverview(tx, tenantId, cfg)));
  });
  return r;
}
