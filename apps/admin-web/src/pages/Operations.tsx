import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { DeadJob } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { Gated } from "@/components/bits";
import { ConfirmModal, Empty, ErrorState, Loading, PageHeader } from "@/components/common";
import { ago, fmtDate, fmtNum } from "@/lib/format";
import { errMsg } from "@/lib/errors";

const PAGE = 25;
function Pager({ offset, n, total, set }: { offset: number; n: number; total: number; set: (o: number) => void }) {
  return (
    <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
      <span className="text-muted-foreground tabular-nums">{offset + 1}-{offset + n} of {total}</span>
      <div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => set(Math.max(0, offset - PAGE))}><ChevronLeft aria-hidden />Previous</Button><Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => set(offset + PAGE)}>Next<ChevronRight aria-hidden /></Button></div>
    </div>
  );
}

function DeadJobs() {
  const { can } = useAuth();
  const [offset, setOffset] = useState(0);
  const [discard, setDiscard] = useState<DeadJob | null>(null);
  const q = useQuery({ queryKey: keys.deadJobs(offset), queryFn: () => adminApi.deadJobs(PAGE, offset), placeholderData: (p) => p });
  const retry = useMutation({ mutationFn: (id: string) => adminApi.retryJob(id), onSuccess: () => toast.success("Job requeued"), onError: (e) => toast.error(errMsg(e)) });
  const drop = useMutation({ mutationFn: (id: string) => adminApi.discardJob(id), onSuccess: () => { setDiscard(null); toast.success("Job discarded"); }, onError: (e) => toast.error(errMsg(e)) });
  if (q.isPending) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <Empty title="No dead jobs" body="Every background job either finished or is still being retried." />;
  return (
    <div className="rounded-xl border bg-card">
      <ul className="divide-y">
        {q.data.items.map((j) => (
          <li key={j.id} className="space-y-2 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="destructive">Dead</Badge><span className="font-mono text-sm font-medium">{j.name}</span>
              <span className="text-xs text-muted-foreground">{j.attempts}/{j.maxAttempts} attempts · failed {ago(j.updatedAt)}</span>
              {j.tenantId && <Link to={`/customers/${j.tenantId}?tab=issues`} className="text-sm font-medium underline-offset-4 hover:underline">{j.tenantName}</Link>}
              <div className="ml-auto flex gap-2">
                <Gated allowed={can("jobActions")} reason={whoCan("jobActions")}><Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(j.id)}><RotateCcw aria-hidden />Retry</Button></Gated>
                <Gated allowed={can("jobActions")} reason={whoCan("jobActions")}><Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDiscard(j)}><Trash2 aria-hidden />Discard</Button></Gated>
              </div>
            </div>
            {j.lastError && <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5 font-mono text-xs">{j.lastError}</pre>}
          </li>
        ))}
      </ul>
      <Pager offset={offset} n={q.data.items.length} total={q.data.total} set={setOffset} />
      {discard && <ConfirmModal danger title="Discard this job?" body={<>The <span className="font-mono">{discard.name}</span> job is deleted and will not run again. This is audited.</>} confirm="Discard" busy={drop.isPending} onConfirm={() => drop.mutate(discard.id)} onClose={() => setDiscard(null)} />}
    </div>
  );
}

function FailedWebhooks() {
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: keys.failedWebhooks(offset), queryFn: () => adminApi.failedWebhooks(PAGE, offset), placeholderData: (p) => p });
  if (q.isPending) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <Empty title="No failed webhooks" body="Every outgoing webhook delivery succeeded or is still being retried." />;
  return (
    <div className="rounded-xl border bg-card">
      <ul className="divide-y">
        {q.data.items.map((w) => (
          <li key={w.id} className="space-y-2 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="destructive">{w.responseStatus ? `HTTP ${w.responseStatus}` : "No response"}</Badge>
              <span className="text-sm font-medium">{w.webhookName}</span><span className="font-mono text-xs text-muted-foreground">{w.eventType}</span>
              <Link to={`/customers/${w.tenantId}?tab=issues`} className="text-sm font-medium underline-offset-4 hover:underline">{w.tenantName}</Link>
              <span className="ml-auto text-xs text-muted-foreground" title={fmtDate(w.completedAt ?? w.createdAt)}>{w.attempts} attempts · {ago(w.completedAt ?? w.createdAt)}</span>
            </div>
            {w.lastError && <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5 font-mono text-xs">{w.lastError}</pre>}
          </li>
        ))}
      </ul>
      <Pager offset={offset} n={q.data.items.length} total={q.data.total} set={setOffset} />
    </div>
  );
}

export default function Operations() {
  const [tab, setTab] = useState("jobs");
  const health = useQuery({ queryKey: keys.health, queryFn: adminApi.health, refetchInterval: 30_000 });
  const h = health.data;
  return (
    <div className="space-y-4">
      <PageHeader title="Operations" subtitle="Queue and worker health, background jobs that gave up, and webhook deliveries that failed, across every customer." />
      {h && (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Worker", h.worker.ok ? `Alive, ${h.worker.ageSec ?? 0}s ago` : h.worker.lastHeartbeatAt ? `Silent since ${ago(h.worker.lastHeartbeatAt)}` : "No heartbeat yet", !h.worker.ok],
            ["Queue", `${fmtNum(h.queue.queued)} queued, ${fmtNum(h.queue.running)} running`, false],
            ["Oldest queued", h.queue.oldestQueuedAgeSec === null ? "Queue is empty" : `${h.queue.oldestQueuedAgeSec}s`, (h.queue.oldestQueuedAgeSec ?? 0) > 300],
            ["Dead jobs", fmtNum(h.queue.dead), h.queue.dead > 0],
          ].map(([k, v, bad]) => <div key={String(k)} className="rounded-xl border bg-card px-4 py-3"><dt className="text-xs uppercase tracking-wide text-muted-foreground">{k}</dt><dd className={`mt-0.5 font-display text-lg font-semibold ${bad ? "text-destructive" : ""}`}>{v}</dd></div>)}
        </dl>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto justify-start gap-0.5 rounded-none border-b bg-transparent p-0">
          <TabsTrigger value="jobs" className="min-h-11 flex-none rounded-none border-b-2 border-transparent px-3.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Dead jobs{h && h.queue.dead > 0 ? ` (${h.queue.dead})` : ""}</TabsTrigger>
          <TabsTrigger value="webhooks" className="min-h-11 flex-none rounded-none border-b-2 border-transparent px-3.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Failed webhooks</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "jobs" ? <DeadJobs /> : <FailedWebhooks />}
    </div>
  );
}
