import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "../common/api";
import { Check, ErrorState, Loading } from "../common/ui";
import { adminCreditKeys, creditsAdmin, CREDITS_METRIC, type PlanRow } from "./creditsApi";

function PlanLine({ plan }: { plan: PlanRow }) {
  const current = plan.limits[CREDITS_METRIC];
  const [unlimited, setUnlimited] = useState(current === null);
  const [val, setVal] = useState(current == null ? "" : String(current));
  const n = Number(val);
  const ok = unlimited || (val.trim() !== "" && Number.isInteger(n) && n >= 0);
  const save = useMutation({ mutationFn: () => creditsAdmin.setPlanCredits(plan.key, unlimited ? null : n), onSuccess: () => toast.success(`Allowance saved for ${plan.name}`), onError: (e) => toast.error(errMsg(e)) });
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <div className="min-w-0"><p className="font-medium">{plan.name}</p><p className="font-mono text-sm text-muted-foreground">{plan.key}</p></div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1.5 text-sm font-medium">Credits per month<Input inputMode="numeric" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)} className="w-40" aria-label={`Monthly credits for ${plan.name}`} /></label>
        <Check label="Unlimited" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} aria-label={`${plan.name} unlimited`} />
      </div>
      <Button disabled={!ok || save.isPending} onClick={() => save.mutate()}>Save<span className="sr-only"> allowance for {plan.name}</span></Button>
    </li>
  );
}

/** Monthly credit allowance per plan (`llm_credits_monthly`, whole credits; unlimited = no limit). */
export default function PlansTab() {
  const q = useQuery({ queryKey: adminCreditKeys.plans, queryFn: creditsAdmin.plans });
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">Each plan includes this many credits every UTC month. An upgrade takes effect immediately; unused allowance does not carry over, bought credits do.</p>
      {q.isPending ? <Loading label="Loading plans" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : <Card className="gap-0 p-0"><ul className="divide-y">{q.data.map((p) => <PlanLine key={p.key} plan={p} />)}</ul></Card>}
    </div>
  );
}
