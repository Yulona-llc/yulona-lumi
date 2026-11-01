import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TenantDetail } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { DefList, Gated, Section } from "@/components/bits";
import { BarSeries, Meter } from "@/components/charts";
import { ErrorState, Loading } from "@/components/common";
import { fillDays, fmtCredits, fmtNum, titleCase } from "@/lib/format";

export default function UsageTab({ id, d, onGrant }: { id: string; d: TenantDetail; onGrant: () => void }) {
  const { can } = useAuth();
  const [days, setDays] = useState(30);
  const usage = useQuery({ queryKey: keys.aiUsage(id, days), queryFn: () => adminApi.aiUsage(id, days) });
  const c = d.credits;
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of usage.data?.series ?? []) m.set(r.day.slice(0, 10), (m.get(r.day.slice(0, 10)) ?? 0) + r.creditsMicro);
    return fillDays([...m].map(([day, value]) => ({ day, value })), Math.min(days, 90), 1 / 1_000_000).map((p) => ({ ...p, y: Math.round(p.y * 100) / 100 }));
  }, [usage.data, days]);
  const byModel = useMemo(() => {
    const m = new Map<string, { requests: number; tokens: number; credits: number }>();
    for (const r of usage.data?.series ?? []) {
      const e = m.get(r.model) ?? { requests: 0, tokens: 0, credits: 0 };
      e.requests += r.requests; e.tokens += r.promptTokens + r.completionTokens; e.credits += r.creditsMicro; m.set(r.model, e);
    }
    return [...m].sort((a, b) => b[1].credits - a[1].credits);
  }, [usage.data]);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4">
        <Section title="Credits" hint={c.unlimited ? "Unlimited on this plan" : `${titleCase(c.period)} allowance`}
          actions={<Gated allowed={can("grantCredits")} reason={whoCan("grantCredits")}><Button size="sm" variant="outline" onClick={onGrant}><Coins aria-hidden />Grant or adjust</Button></Gated>}>
          {c.unlimited ? <p className="text-sm text-muted-foreground">No credit limit applies.</p> : (
            <div className="space-y-4">
              <Meter used={Math.round(c.usedMicro / 1_000_000)} limit={Math.round((c.allowanceMicro + c.topupMicro) / 1_000_000)} warning={c.status === "warning"} />
              <DefList rows={[["Remaining", fmtCredits(c.remainingMicro)], ["Plan allowance", fmtCredits(c.allowanceMicro)], ["Used", fmtCredits(c.usedMicro)], ["Bought or granted", fmtCredits(c.topupMicro)], ["Status", titleCase(c.status)]]} />
              {c.warnings.length > 0 && <ul className="list-disc pl-5 text-sm text-muted-foreground">{c.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            </div>
          )}
        </Section>
      </div>
      <div className="space-y-4 lg:col-span-2">
        <Section title="AI usage" actions={
          <div role="group" aria-label="Date range" className="inline-flex rounded-lg border p-0.5">
            {[7, 30, 90].map((r) => <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)} className={`min-h-8 rounded-md px-2.5 text-xs font-medium ${days === r ? "bg-primary/15 text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}>{r} days</button>)}
          </div>}>
          {usage.isPending ? <Loading rows={2} /> : usage.isError ? <ErrorState error={usage.error} retry={() => void usage.refetch()} /> : (
            <div className="space-y-5">
              <BarSeries label="Credits used per day" data={perDay} height={120} />
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div><dt className="text-muted-foreground">Requests</dt><dd className="font-display text-lg font-semibold tabular-nums">{fmtNum(usage.data.totals.requests)}</dd></div>
                <div><dt className="text-muted-foreground">Tokens</dt><dd className="font-display text-lg font-semibold tabular-nums">{fmtNum(usage.data.totals.promptTokens + usage.data.totals.completionTokens)}</dd></div>
                <div><dt className="text-muted-foreground">Credits</dt><dd className="font-display text-lg font-semibold tabular-nums">{fmtCredits(usage.data.totals.creditsMicro)}</dd></div>
              </dl>
              {byModel.length > 0 && (
                <div className="-mx-4 overflow-x-auto">
                  <Table><TableHeader><TableRow><TableHead>Model</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Credits</TableHead></TableRow></TableHeader>
                    <TableBody>{byModel.map(([m, v]) => <TableRow key={m}><TableCell className="font-mono text-xs">{m}</TableCell><TableCell className="text-right tabular-nums">{fmtNum(v.requests)}</TableCell><TableCell className="text-right tabular-nums">{fmtNum(v.tokens)}</TableCell><TableCell className="text-right tabular-nums">{fmtCredits(v.credits)}</TableCell></TableRow>)}</TableBody></Table>
                </div>
              )}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
