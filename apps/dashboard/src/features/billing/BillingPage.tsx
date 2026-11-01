import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { AlertTriangle, CreditCard, Gauge, Loader2, Sparkles, TrendingUp } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Stagger, StaggerItem } from "@/components/motion";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { BarSeries } from "../common/charts";
import { ConfirmModal, ErrorState, fmtDate, Loading, PageHeader, RoleNotice, Select, useRole } from "../common/ui";
import { CreditAlerts, CreditsReturnToast } from "../usage/CreditAlerts";
import { useCredits } from "../usage/hooks";
import { fmtNum, messagesLeftText } from "../usage/api";
import { billingApi, METRIC_LABEL, type BillingInfo, type LimitRow } from "./api";

const stateInfo: Record<BillingInfo["state"], { variant: "success" | "warning" | "destructive" | "secondary"; text: string }> = {
  ok: { variant: "success", text: "Active" }, warning: { variant: "warning", text: "Near limits" },
  grace: { variant: "warning", text: "Payment failed" }, restricted: { variant: "destructive", text: "Restricted" }, canceled: { variant: "secondary", text: "Canceled" },
};
const nf = new Intl.NumberFormat();

/** Usage meter: the bar fills from empty on first paint; colour follows how close the limit is. */
function UsageMeter({ l }: { l: LimitRow }) {
  const pct = l.limit ? Math.min(100, (l.used / l.limit) * 100) : 0;
  const over = l.limit !== null && l.used >= l.limit;
  const near = !over && (l.warning || pct >= 80);
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = requestAnimationFrame(() => setShown(pct)); return () => cancelAnimationFrame(t); }, [pct]);
  const label = METRIC_LABEL[l.metric] ?? l.metric;
  return (
    <li>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        {over ? <span className="font-medium text-destructive">At limit</span> : near ? <span className="font-medium text-warning">Near limit</span> : null}
      </div>
      <Progress value={shown} aria-label={`${label} usage`} className={cn("h-2.5", over && "[&>div]:bg-destructive", near && "[&>div]:bg-warning")} />
      <p className="mt-1.5 text-sm tabular-nums text-muted-foreground">{nf.format(l.used)} / {l.limit === null ? "unlimited" : nf.format(l.limit)}</p>
    </li>
  );
}

const planLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");

/** Plan card allowance: credits and tokens per month, plus the estimated messages left (SaaS credits only). */
function PlanAllowance({ b, credits }: { b: BillingInfo; credits: ReturnType<typeof useCredits>["data"] }) {
  const lim = (m: string) => b.limits.find((l) => l.metric === m);
  const cr = lim("llm_credits_monthly"), tk = lim("llm_tokens_monthly");
  if (!credits?.enabled || !cr) return null;
  const parts = [cr.limit === null ? "Unlimited AI credits" : `${fmtNum(cr.limit)} credits a month`, tk && tk.limit !== null ? `${fmtNum(tk.limit)} tokens` : null].filter(Boolean).join(" and ");
  const left = messagesLeftText(credits.estimatedMessages);
  return (
    <p className="mt-1 text-sm text-muted-foreground" data-testid="plan-allowance">
      {parts}{left ? <>, <span className="font-medium text-foreground">{left}</span></> : null}
    </p>
  );
}

export default function BillingPage() {
  const { isAdmin, isOwner } = useRole();
  const info = useQuery({ queryKey: ["billing"], queryFn: billingApi.info, enabled: isAdmin });
  const cq = useCredits();
  const usage = useQuery({ queryKey: ["usage", 30], queryFn: () => billingApi.usage(30) });
  const [metric, setMetric] = useState("conversations");
  const [cancel, setCancel] = useState(false);
  const go = useMutation({
    mutationFn: (f: () => Promise<{ url: string }>) => f(),
    onSuccess: (r) => { toast.success("Redirecting to payment"); window.location.assign(r.url); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const cx = useMutation({
    mutationFn: billingApi.cancel,
    onSuccess: () => { setCancel(false); void info.refetch(); toast.success("Plan canceled"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!isAdmin) return <><PageHeader title="Billing" /><RoleNotice what="viewing billing" /></>;
  if (info.isPending) return <div className="max-w-5xl space-y-5"><PageHeader title="Billing" /><Skeleton className="h-36 w-full rounded-xl" /><Skeleton className="h-64 w-full rounded-xl" /></div>;
  if (info.isError) return <ErrorState error={info.error} retry={() => void info.refetch()} />;
  const b = info.data, st = stateInfo[b.state];
  const series = (usage.data?.series ?? []).filter((s) => s.metric === metric).map((s) => ({ x: s.day, y: s.value }));
  const metrics = Array.from(new Set((usage.data?.series ?? []).map((s) => s.metric)));
  const paid = b.checkoutPlans[0];
  return (
    <Stagger className="max-w-5xl space-y-5">
      <StaggerItem><PageHeader title="Billing" subtitle="Your plan, what you have used, and payment management." /></StaggerItem>
      <CreditsReturnToast />
      <CreditAlerts />
      {b.state === "grace" && <Alert variant="warning"><AlertTriangle /><AlertTitle>Your last payment failed.</AlertTitle><AlertDescription>Your plan stays active until {fmtDate(b.subscription.graceUntil)}; after that the workspace moves to Free. Update your payment method in the billing portal.</AlertDescription></Alert>}
      {b.state === "restricted" && <Alert variant="destructive"><AlertTriangle /><AlertTitle>The grace period ended.</AlertTitle><AlertDescription>The workspace was moved to the Free plan.</AlertDescription></Alert>}
      {b.state === "warning" && <Alert variant="warning" role="status"><TrendingUp /><AlertTitle>One or more limits are above 80%.</AlertTitle><AlertDescription>{paid && isOwner ? "Consider upgrading before you hit a limit." : "Ask an owner to upgrade before you hit a limit."}</AlertDescription></Alert>}
      <StaggerItem>
        <Card className="gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent text-accent-foreground"><Sparkles className="size-6" /></span>
            <div>
              <p className="text-sm text-muted-foreground">Current plan</p>
              <p className="flex flex-wrap items-center gap-2 font-display text-2xl font-semibold">{b.plan.name} <Badge variant={st.variant}>{st.text}</Badge></p>
              {b.subscription.currentPeriodEnd && <p className="mt-1 text-sm text-muted-foreground">{b.subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} {fmtDate(b.subscription.currentPeriodEnd)}</p>}
              <PlanAllowance b={b} credits={cq.data} />
              {b.provider === "stub" && <p className="mt-1 text-sm text-muted-foreground">Payments are not configured on this installation.</p>}
            </div>
          </div>
          {isOwner ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {b.checkoutPlans.map((p) => b.plan.key !== p && <Button key={p} disabled={go.isPending} onClick={() => go.mutate(() => billingApi.checkout(p))}>{go.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}Upgrade to {planLabel(p)}</Button>)}
              {b.subscription.status !== "none" && <Button variant="outline" disabled={go.isPending} onClick={() => go.mutate(billingApi.portal)}><CreditCard />Manage payment</Button>}
              {["active", "trialing", "past_due"].includes(b.subscription.status) && !b.subscription.cancelAtPeriodEnd && <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setCancel(true)}>Cancel plan</Button>}
            </div>
          ) : <p className="text-sm text-muted-foreground">Only owners can change the plan.</p>}
        </Card>
      </StaggerItem>
      <StaggerItem>
        <Card>
          <div className="flex items-center justify-between gap-3"><h2 className="font-display text-lg font-semibold">Usage vs limits</h2><Link to="/settings/usage" className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-accent-foreground underline-offset-4 hover:underline"><Gauge className="size-4" aria-hidden />AI credits and usage</Link></div>
          <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2">{b.limits.map((l) => <UsageMeter key={l.metric} l={l} />)}</ul>
        </Card>
      </StaggerItem>
      <StaggerItem>
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold">Last 30 days</h2>
            {metrics.length > 1 && <Select label="" aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)} className="!w-auto">{metrics.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}</Select>}
          </div>
          {usage.isPending ? <Loading /> : usage.isError ? <ErrorState error={usage.error} /> : <BarSeries data={series} label={metric.replace(/_/g, " ")} />}
        </Card>
      </StaggerItem>
      {cancel && <ConfirmModal danger title="Cancel subscription?" body="Your plan falls back to Free once the provider confirms. Limits on Free may block new items." confirm="Cancel plan" busy={cx.isPending} onConfirm={() => cx.mutate()} onClose={() => setCancel(false)} />}
    </Stagger>
  );
}
