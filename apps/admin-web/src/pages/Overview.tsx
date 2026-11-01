import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, CircleAlert, CircleX } from "lucide-react";
import { Card } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/motion";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { PlatformHealth } from "@/api/types";
import { BarSeries, BucketBar, Delta, HBars, Sparkline } from "@/components/charts";
import { Section, HealthBadge } from "@/components/bits";
import { ErrorState, Loading, PageHeader } from "@/components/common";
import { ago, fillDays, fmtMoney, fmtNum, titleCase } from "@/lib/format";

function Kpi({ label, value, format, delta, spark, hint, to }: { label: string; value: number; format?: (n: number) => string; delta?: ReactNode; spark?: number[]; hint?: ReactNode; to?: string }) {
  const body = (
    <Card className="h-full gap-1 p-4 transition-colors hover:border-ring/40">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-display text-[1.75rem] font-semibold leading-tight tabular-nums tracking-tight"><AnimatedNumber value={value} format={format} /></p>
      <div className="min-h-4">{delta ?? (hint && <span className="text-xs text-muted-foreground">{hint}</span>)}</div>
      {spark && <Sparkline data={spark} className="mt-1" />}
    </Card>
  );
  return to ? <Link to={to} className="block rounded-xl focus-visible:outline-offset-0">{body}</Link> : body;
}

function HealthCard({ h }: { h: PlatformHealth }) {
  const Icon = h.status === "ok" ? CheckCircle2 : h.status === "degraded" ? CircleAlert : CircleX;
  const tone = h.status === "ok" ? "text-success" : h.status === "degraded" ? "text-warning" : "text-destructive";
  const row = (k: string, v: ReactNode, bad = false) => <div className="flex items-center justify-between gap-3 py-1.5 text-sm"><dt className="text-muted-foreground">{k}</dt><dd className={bad ? "font-medium text-destructive" : "tabular-nums"}>{v}</dd></div>;
  return (
    <Section title="Platform health" actions={<span className={`inline-flex items-center gap-1.5 text-sm font-medium ${tone}`}><Icon className="size-4" aria-hidden />{h.status === "ok" ? "All systems normal" : h.status === "degraded" ? "Degraded" : "Down"}</span>}>
      <dl className="divide-y">
        {row("Database", h.db.ok ? `OK, ${h.db.latencyMs} ms` : "Unreachable", !h.db.ok)}
        {row("Worker", h.worker.ok ? `Heartbeat ${h.worker.ageSec ?? 0}s ago` : h.worker.lastHeartbeatAt ? `Silent since ${ago(h.worker.lastHeartbeatAt)}` : "No heartbeat", !h.worker.ok)}
        {row("Queue", `${fmtNum(h.queue.queued)} queued, ${fmtNum(h.queue.running)} running`)}
        {row("Oldest queued job", h.queue.oldestQueuedAgeSec === null ? "Queue is empty" : `${h.queue.oldestQueuedAgeSec}s`, (h.queue.oldestQueuedAgeSec ?? 0) > 300)}
        {row("Dead jobs", <Link to="/operations" className="underline underline-offset-4">{fmtNum(h.queue.dead)}</Link>, h.queue.dead > 0)}
      </dl>
    </Section>
  );
}

const RANGES = [7, 14, 30] as const;

export default function Overview() {
  const q = useQuery({ queryKey: keys.overview, queryFn: adminApi.overview });
  const health = useQuery({ queryKey: keys.health, queryFn: adminApi.health, refetchInterval: 30_000 });
  const [days, setDays] = useState<number>(30);
  if (q.isPending) return <><PageHeader title="Overview" /><Loading label="Loading overview" rows={4} /></>;
  if (q.isError) return <><PageHeader title="Overview" /><ErrorState error={q.error} retry={() => void q.refetch()} /></>;
  const o = q.data;
  const spark = (s: Array<{ day: string; value: number }>, scale = 1) => fillDays(s, 30, scale).map((p) => p.y);
  return (
    <div className="space-y-5">
      <PageHeader title="Overview" subtitle="Platform state at a glance. Every number comes from the last 30 days unless it says otherwise." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Kpi label="Customers" value={o.tenants.active} to="/customers?status=active" delta={<Delta cur={o.tenants.new30d} prev={o.tenants.newPrev30d} label="new vs prior 30 days" />} spark={spark(o.series.signups)} hint={`${fmtNum(o.tenants.total)} in total`} />
        <Kpi label="MRR" value={o.mrrCents} format={(n) => fmtMoney(Math.round(n))} hint="From active plans" />
        <Kpi label="Active, 7 days" value={o.active7d} delta={<Delta cur={o.active7d} prev={o.activePrev7d} label="vs prior 7 days" />} hint="Customers with messages" />
        <Kpi label="New, 30 days" value={o.tenants.new30d} delta={<Delta cur={o.tenants.new30d} prev={o.tenants.newPrev30d} />} spark={spark(o.series.signups)} />
        <Kpi label="Suspended" value={o.tenants.suspended} to="/customers?status=suspended" hint={`${fmtNum(o.tenants.deleted)} deleted`} />
        <Kpi label="Credits used, 30 days" value={o.creditsConsumed30d / 1_000_000} format={(n) => fmtNum(Math.round(n))} delta={<Delta cur={o.creditsConsumed30d} prev={o.creditsConsumedPrev30d} />} spark={spark(o.series.credits, 1 / 1_000_000)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Customers by health" hint="Active customers only" className="lg:col-span-1">
          <BucketBar counts={o.healthBuckets} />
          <div className="mt-5"><HBars label="Customers by plan" rows={o.byPlan.map((p) => ({ k: titleCase(p.plan), v: p.count }))} /></div>
        </Section>
        <Section title="Needs attention now" hint="Worst health first" className="lg:col-span-2"
          actions={<Link to="/attention" className="inline-flex items-center gap-1 text-sm font-medium text-accent-foreground hover:underline">Open the queue<ArrowRight className="size-3.5" aria-hidden /></Link>}>
          {o.attention.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing needs attention. Every active customer is healthy.</p> : (
            <ul className="-my-2 divide-y">
              {o.attention.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <Link to={`/customers/${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 hover:bg-muted/40 sm:flex-nowrap">
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{a.name}</p><p className="truncate text-xs text-muted-foreground">{a.health.reasons[0]?.label ?? "No specific reason"}{a.health.reasons.length > 1 ? ` and ${a.health.reasons.length - 1} more` : ""}</p></div>
                    <HealthBadge health={a.health} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Growth and usage" actions={
            <div role="group" aria-label="Date range" className="inline-flex rounded-lg border p-0.5">
              {RANGES.map((r) => <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)} className={`min-h-8 rounded-md px-2.5 text-xs font-medium ${days === r ? "bg-primary/15 text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}>{r} days</button>)}
            </div>}>
            <div className="grid gap-6 md:grid-cols-3">
              <BarSeries label="Signups" data={fillDays(o.series.signups, days)} height={110} />
              <BarSeries label="Conversations" data={fillDays(o.series.conversations, days)} height={110} />
              <BarSeries label="Credits used" data={fillDays(o.series.credits, days, 1 / 1_000_000).map((p) => ({ ...p, y: Math.round(p.y * 100) / 100 }))} height={110} />
            </div>
          </Section>
        </div>
        {health.data ? <HealthCard h={health.data} /> : <Section title="Platform health">{health.isError ? <ErrorState error={health.error} retry={() => void health.refetch()} /> : <Loading rows={2} />}</Section>}
      </div>
      <p className="text-xs text-muted-foreground">Health scores use the last 7 days of failures, credits and activity.</p>
    </div>
  );
}
