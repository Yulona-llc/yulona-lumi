import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge, ErrorState, Loading, PageHeader } from "../common/ui";
import { adminApi } from "./api";
import { BarSeries, HBars, Stat } from "./charts";

const hc = { ok: "green", degraded: "amber", down: "red" } as const;

export default function OverviewPage() {
  const a = useQuery({ queryKey: ["admin", "analytics"], queryFn: adminApi.analytics });
  const h = useQuery({ queryKey: ["admin", "health"], queryFn: adminApi.health, refetchInterval: 15_000 });
  return (
    <div className="space-y-6">
      <PageHeader title="Platform overview" subtitle="Tenants, revenue estimate, conversation volume and system health." />
      <Card><div className="flex items-center gap-3"><h2 className="font-display text-lg font-semibold">System health</h2>{h.data && <Badge color={hc[h.data.status]}>{h.data.status}</Badge>}</div>
        {h.isPending ? <Loading /> : h.isError ? <ErrorState error={h.error} retry={() => void h.refetch()} /> : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat className="bg-muted/50 shadow-none" label="Database" value={h.data.db.ok ? `${h.data.db.latencyMs} ms` : "Down"} hint={h.data.db.ok ? "OK" : "Not reachable"} />
            <Stat className="bg-muted/50 shadow-none" label="Queue" value={String(h.data.queue.queued)} hint={`queued, ${h.data.queue.running} running, ${h.data.queue.dead} dead${h.data.queue.oldestQueuedAgeSec != null ? `, oldest ${h.data.queue.oldestQueuedAgeSec}s` : ""}`} />
            <Stat className="bg-muted/50 shadow-none" label="Worker" value={h.data.worker.ok ? "Alive" : "Stale"} hint={h.data.worker.ageSec != null ? `Heartbeat ${h.data.worker.ageSec}s ago` : "No heartbeat yet"} />
            <Stat className="bg-muted/50 shadow-none" label="Dead jobs" value={String(h.data.queue.dead)} hint={h.data.queue.dead ? "Needs attention" : "None"} /></div>)}</Card>
      {a.isPending ? <Loading /> : a.isError ? <ErrorState error={a.error} retry={() => void a.refetch()} /> : (<>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Tenants" count={a.data.tenants.total} hint={`${a.data.tenants.active} active, ${a.data.tenants.suspended} suspended`} />
          <Stat label="New in 30 days" count={a.data.tenants.new30d} />
          <Stat label="MRR (estimate)" value={`$${(a.data.mrrCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} hint="From plan prices, not accounting" />
          <Stat label="Conversations, 30 days" count={a.data.conversations.last30d} /></div>
        <Card><BarSeries label="Conversations per day" data={a.data.conversations.perDay.map((d) => ({ x: d.day, y: d.count }))} /></Card>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><HBars label="Conversion funnel (conversations by stage)" rows={a.data.funnel.map((f) => ({ k: f.stage, v: f.conversations }))} /></Card>
          <Card><HBars label="Tenants by plan" rows={a.data.byPlan.map((p) => ({ k: p.plan, v: p.count }))} /></Card></div></>)}
    </div>
  );
}
