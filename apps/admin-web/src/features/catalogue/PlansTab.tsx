import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "@/lib/errors";
import { Check, ErrorState, Loading } from "@/components/common";
import { fmtNum, typicalMessageCredits } from "@/lib/format";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { PlanRow } from "@/api/types";
const CREDITS_METRIC = "llm_credits_monthly";

const TOKENS_METRIC = "llm_tokens_monthly";
const COPILOT_METRIC = "copilot_credits_monthly";

/** Ask Lumi copilot allowance (`copilot_credits_monthly`): separate from chat credits; 0 = locked, unlimited = no limit. */
function CopilotLine({ plan }: { plan: PlanRow }) {
  const current = plan.limits[COPILOT_METRIC];
  const [unlimited, setUnlimited] = useState(current === null);
  const [val, setVal] = useState(current == null ? "" : String(current));
  const n = Number(val);
  const ok = unlimited || (val.trim() !== "" && Number.isInteger(n) && n >= 0);
  const save = useMutation({ mutationFn: () => adminApi.setPlanLimit(plan.key, COPILOT_METRIC, unlimited ? null : n), onSuccess: () => toast.success(`Ask Lumi allowance saved for ${plan.name}`), onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="flex flex-wrap items-end gap-4 sm:col-span-3">
      <label className="grid gap-1.5 text-sm font-medium">Ask Lumi credits per month<Input inputMode="numeric" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)} className="w-40" aria-label={`Ask Lumi credits for ${plan.name}`} /></label>
      <Check label="Unlimited" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} aria-label={`${plan.name} Ask Lumi unlimited`} />
      <Button variant="outline" disabled={!ok || save.isPending} onClick={() => save.mutate()}>Save<span className="sr-only"> Ask Lumi allowance for {plan.name}</span></Button>
      <p className="text-xs text-muted-foreground">Separate from chat credits. 0 locks Ask Lumi for the plan.</p>
    </div>
  );
}

function PlanLine({ plan, perMessage }: { plan: PlanRow; perMessage: number | null }) {
  const current = plan.limits[CREDITS_METRIC];
  const [unlimited, setUnlimited] = useState(current === null);
  const [val, setVal] = useState(current == null ? "" : String(current));
  const n = Number(val);
  const ok = unlimited || (val.trim() !== "" && Number.isInteger(n) && n >= 0);
  const save = useMutation({ mutationFn: () => adminApi.setPlanLimit(plan.key, CREDITS_METRIC, unlimited ? null : n), onSuccess: () => toast.success(`Allowance saved for ${plan.name}`), onError: (e) => toast.error(errMsg(e)) });
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <div className="min-w-0">
        <p className="font-medium">{plan.name}</p><p className="font-mono text-sm text-muted-foreground">{plan.key}</p>
        <p className="mt-1 text-sm text-muted-foreground" data-testid={`plan-estimate-${plan.key}`}>
          {estimateText(unlimited ? null : ok ? n : current, plan.limits[TOKENS_METRIC], perMessage)}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1.5 text-sm font-medium">Credits per month<Input inputMode="numeric" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)} className="w-40" aria-label={`Monthly credits for ${plan.name}`} /></label>
        <Check label="Unlimited" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} aria-label={`${plan.name} unlimited`} />
      </div>
      <Button disabled={!ok || save.isPending} onClick={() => save.mutate()}>Save<span className="sr-only"> allowance for {plan.name}</span></Button>
      <CopilotLine plan={plan} />
    </li>
  );
}

/** "4,980 credits, 15,480,000 tokens, about 2,371 messages" for the typical message at the default rate. */
function estimateText(credits: number | null | undefined, tokens: number | null | undefined, perMessage: number | null): string {
  if (credits == null) return "Unlimited credits";
  const msgs = perMessage && perMessage > 0 ? Math.floor(credits / perMessage) : null;
  return [`${fmtNum(credits)} credits`, tokens != null ? `${fmtNum(tokens)} tokens` : null, msgs !== null ? `about ${fmtNum(msgs)} messages` : null].filter(Boolean).join(", ");
}

/** Monthly credit allowance per plan (`llm_credits_monthly`, whole credits; unlimited = no limit). */
export default function PlansTab() {
  const q = useQuery({ queryKey: keys.plans, queryFn: adminApi.plans });
  const rates = useQuery({ queryKey: keys.rates, queryFn: adminApi.rates });
  const def = rates.data?.find((r) => r.model === "*");
  const perMessage = def ? typicalMessageCredits(def.inputMicroPer1k, def.outputMicroPer1k) : null;
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">Each plan includes this many credits every UTC month. An upgrade takes effect immediately; unused allowance does not carry over, bought credits do. Message estimates assume a typical message (about 6k tokens in, 0.6k out) at the default rate.</p>
      {q.isPending ? <Loading label="Loading plans" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : <Card className="gap-0 p-0"><ul className="divide-y">{q.data.map((p) => <PlanLine key={p.key} plan={p} perMessage={perMessage} />)}</ul></Card>}
    </div>
  );
}
