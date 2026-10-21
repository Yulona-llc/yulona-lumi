import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Ban, CircleCheck, UserRoundCog } from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "../../auth/AuthProvider";
import type { Session } from "../../api/contract";
import { errMsg } from "../common/api";
import { Badge, ConfirmModal, ErrorState, fmtDate, Loading, Modal, PageHeader, Select, TextArea } from "../common/ui";
import { METRIC_LABEL } from "../billing/api";
import { adminApi } from "./api";
import { BarSeries, Meter, Stat } from "./charts";
import { impersonation } from "./impersonation";
import { TenantCreditsCard } from "./GrantCredits";

export default function TenantDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { startImpersonation } = useAuth();
  const d = useQuery({ queryKey: ["admin", "tenant", id], queryFn: () => adminApi.detail(id) });
  const u = useQuery({ queryKey: ["admin", "usage", id], queryFn: () => adminApi.usage(id, 30) });
  const [metric, setMetric] = useState("conversations");
  const [susp, setSusp] = useState(false);
  const [imp, setImp] = useState(false);
  const [reason, setReason] = useState("");
  const sus = useMutation({ mutationFn: (on: boolean) => adminApi.suspend(id, on), onSuccess: (_r, on) => { setSusp(false); toast.success(on ? "Tenant suspended" : "Tenant unsuspended"); void qc.invalidateQueries({ queryKey: ["admin", "tenant", id] }); } });
  const im = useMutation({
    mutationFn: () => adminApi.impersonate(id, reason.trim()),
    onSuccess: (r) => { impersonation.start({ sessionId: r.sessionId, tenantName: d.data?.tenant.name ?? "tenant", reason: reason.trim() }); startImpersonation(r as unknown as Session); nav("/inbox"); },
  });
  if (d.isPending) return <Loading />;
  if (d.isError) return <ErrorState error={d.error} retry={() => void d.refetch()} />;
  const t = d.data.tenant, suspended = t.status === "suspended";
  const metrics = Array.from(new Set((u.data?.series ?? []).map((s) => s.metric)));
  const series = (u.data?.series ?? []).filter((s) => s.metric === metric).map((s) => ({ x: s.day, y: s.value }));
  const plan = t.plan ?? t.plan_key ?? "unknown";
  return (
    <div className="space-y-5">
      <Link to="/admin/tenants" className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />All tenants</Link>
      <PageHeader title={t.name} subtitle={`Plan ${plan}. Last activity ${d.data.lastActivityAt ? fmtDate(d.data.lastActivityAt) : "never"}.`}
        actions={<><Badge color={suspended ? "amber" : "green"}>{t.status}</Badge>
          <Button variant="outline" onClick={() => setSusp(true)}>{suspended ? <CircleCheck aria-hidden /> : <Ban aria-hidden />}{suspended ? "Unsuspend" : "Suspend"}</Button>
          <Button disabled={suspended} onClick={() => setImp(true)}><UserRoundCog aria-hidden />Impersonate</Button></>} />
      {sus.isError && <Alert variant="destructive">{errMsg(sus.error)}</Alert>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{Object.entries(d.data.counts).map(([k, v]) => <Stat key={k} label={k.replace(/([A-Z])/g, " $1").toLowerCase()} count={v} />)}</div>
      <Card><div className="flex items-center justify-between"><h2 className="font-display text-lg font-semibold">Plan and limits</h2><Badge color="blue">{plan}</Badge></div>
        <ul className="grid gap-5 sm:grid-cols-2">{d.data.limits.map((l) => <li key={l.metric}><p className="mb-1 text-sm font-medium">{METRIC_LABEL[l.metric] ?? l.metric}</p><Meter used={l.used} limit={l.limit} warning={l.warning} /></li>)}</ul></Card>
      <TenantCreditsCard id={id} />
      <Card><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-lg font-semibold">Usage, 30 days</h2>
        {metrics.length > 1 && <div className="w-44"><Select label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)}>{metrics.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}</Select></div>}</div>
        {u.isPending ? <Loading /> : u.isError ? <ErrorState error={u.error} /> : <BarSeries label={metric.replace(/_/g, " ")} data={series} />}</Card>
      {susp && <ConfirmModal danger={!suspended} title={suspended ? "Unsuspend tenant?" : "Suspend tenant?"} body={suspended ? "Users regain access immediately." : "All users of this tenant lose access until unsuspended."} confirm={suspended ? "Unsuspend" : "Suspend"} busy={sus.isPending} onConfirm={() => sus.mutate(suspended)} onClose={() => setSusp(false)} />}
      {imp && <Modal title="Impersonate tenant owner" onClose={() => setImp(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 5) im.mutate(); }}>
          <p className="text-sm text-muted-foreground">You will act as the tenant's owner (capped at admin) for 15 minutes. The session is audited on both sides and an ember banner stays visible with a Stop impersonating button.</p>
          {im.isError && <Alert variant="destructive">{errMsg(im.error)}</Alert>}
          <TextArea label="Reason (5 to 500 characters)" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={500} required />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setImp(false)}>Cancel</Button><Button disabled={im.isPending || reason.trim().length < 5}>Start impersonation</Button></div></form></Modal>}
    </div>
  );
}
