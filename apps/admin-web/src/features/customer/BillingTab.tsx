import { useQuery } from "@tanstack/react-query";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TenantDetail } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DefList, Gated, Section } from "@/components/bits";
import { ErrorState, Loading } from "@/components/common";
import { fmtDate, fmtMoney, fmtNum, titleCase } from "@/lib/format";

export default function BillingTab({ id, d, onPlan }: { id: string; d: TenantDetail; onPlan: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: keys.billing(id), queryFn: () => adminApi.billing(id) });
  if (q.isPending) return <Loading rows={3} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const b = q.data;
  const s = b.subscription;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Plan and subscription" actions={<Gated allowed={can("changePlan")} reason={whoCan("changePlan")}><Button size="sm" variant="outline" onClick={onPlan}>Change plan</Button></Gated>}>
        <DefList rows={[
          ["Plan", titleCase(b.plan)],
          ["Subscription", s ? <Badge variant={s.status === "active" ? "success" : s.status === "past_due" ? "destructive" : "secondary"}>{titleCase(s.status)}</Badge> : "None (no paid subscription)"],
          ...(s ? [["Renews or ends", fmtDate(s.currentPeriodEnd)] as [string, string], ["Cancels at period end", s.cancelAtPeriodEnd ? "Yes" : "No"] as [string, string], ...(s.graceUntil ? [["Grace until", fmtDate(s.graceUntil)] as [string, string]] : [])] : []),
          ["Credit mode", titleCase(d.credits.mode)],
        ]} />
      </Section>
      <Section title="Credit top-ups" hint="Packs bought and credits granted">
        {b.topups.length === 0 ? <p className="text-sm text-muted-foreground">No top-ups.</p> : (
          <ul className="divide-y">{b.topups.map((t, i) => <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"><span className="min-w-0"><span className="font-medium tabular-nums">{fmtNum(t.credits)} credits</span><span className="block text-xs text-muted-foreground">{t.pack ?? "Granted by an admin"} · {fmtDate(t.at)}</span></span><span className="tabular-nums text-muted-foreground">{t.amountCents ? fmtMoney(t.amountCents) : "Free"}</span></li>)}</ul>
        )}
      </Section>
      <Section title="Billing events" hint="Webhook events received from the payment provider" className="lg:col-span-2">
        {b.events.length === 0 ? <p className="text-sm text-muted-foreground">No events.</p> : <ul className="divide-y">{b.events.map((e, i) => <li key={i} className="flex justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"><span className="font-mono text-xs">{e.type}</span><time className="text-xs text-muted-foreground">{fmtDate(e.receivedAt)}</time></li>)}</ul>}
      </Section>
    </div>
  );
}
