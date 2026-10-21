import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Download, Server, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { Stagger, StaggerItem } from "@/components/motion";
import { errMsg } from "../common/api";
import { Empty, ErrorState, PageHeader, RoleNotice, useRole } from "../common/ui";
import { BarSeries } from "../admin/charts";
import { Breakdown } from "./Breakdown";
import { BuyCreditsDialog } from "./BuyCreditsDialog";
import { CreditAlerts } from "./CreditAlerts";
import { Gauge } from "./Gauge";
import { creditKeys, creditsApi, fmtCredits, fmtNum, nextReset, rangeFor, toCredits, type GroupBy } from "./api";
import { useCredits } from "./hooks";

const RANGES = [7, 30, 90] as const;
const TABS: Array<{ id: Exclude<GroupBy, "day">; label: string; name: string }> = [
  { id: "agent", label: "By agent", name: "Agent" }, { id: "model", label: "By model", name: "Model" }, { id: "conversation", label: "Top conversations", name: "Conversation" },
];

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function UsagePage() {
  const { isAdmin } = useRole();
  const cq = useCredits();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [tab, setTab] = useState<Exclude<GroupBy, "day">>("agent");
  const [metric, setMetric] = useState<"credits" | "tokens">("credits");
  const [buy, setBuy] = useState(false);
  const { from, to } = useMemo(() => rangeFor(days), [days]);
  const day = useQuery({ queryKey: creditKeys.report("day", from, to), queryFn: () => creditsApi.report("day", from, to), enabled: isAdmin });
  const group = useQuery({ queryKey: creditKeys.report(tab, from, to), queryFn: () => creditsApi.report(tab, from, to), enabled: isAdmin });
  const exp = useMutation({
    mutationFn: () => creditsApi.exportCsv(tab, from, to),
    onSuccess: () => toast.success("CSV exported"), onError: (e) => toast.error(errMsg(e)),
  });

  if (cq.isPending) return <div className="max-w-5xl space-y-5"><PageHeader title="Usage" /><Skeleton className="h-80 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>;
  if (cq.isError) return <ErrorState error={cq.error} retry={() => void cq.refetch()} />;
  const c = cq.data;
  const saas = !!c?.enabled; // selfhosted, or a server without credits: tokens and requests only
  const useCreditsMetric = saas && metric === "credits";
  const series = (day.data?.items ?? []).map((i) => ({ x: i.key, y: useCreditsMetric ? Math.round(toCredits(i.creditsMicro) * 100) / 100 : i.totalTokens }));
  const t = day.data?.totals;

  return (
    <Stagger className="max-w-5xl space-y-5">
      <StaggerItem><PageHeader title="Usage" subtitle={saas ? "AI credits, tokens and where they went." : "Tokens and requests your assistants used."}
        actions={saas && isAdmin ? <Button onClick={() => setBuy(true)}><Sparkles aria-hidden />Buy credits</Button> : undefined} /></StaggerItem>

      {saas && <CreditAlerts showUsageLink={false} showBuy={false} />}

      {saas && c ? (
        <StaggerItem>
          <Card className="gap-6 p-5 sm:p-7 md:grid md:grid-cols-[17rem_minmax(0,1fr)] md:items-center md:gap-10" data-testid="credits-hero">
            <Gauge remainingMicro={c.remainingMicro} percent={c.percentUsed} status={c.status} unlimited={c.unlimited} />
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-lg font-semibold">This month</h2>
                <p className="text-sm text-muted-foreground">{c.unlimited ? "Your plan has no credit limit." : <>Your allowance resets on {nextReset(c.period)}. Top-ups carry over.</>}</p>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                {!c.unlimited && <Fact label="Monthly allowance" value={fmtCredits(c.allowanceMicro)} />}
                <Fact label="Used this month" value={fmtCredits(c.usedMicro + c.topupUsedMicro)} />
                {!c.unlimited && <Fact label="Top-up balance" value={fmtCredits(c.topupMicro)} hint="Never expires" />}
              </dl>
            </div>
          </Card>
        </StaggerItem>
      ) : (
        <StaggerItem>
          <Alert variant="info"><Server /><AlertTitle>Usage on your own provider key is not charged</AlertTitle>
            <AlertDescription>This workspace runs on your own AI provider account, so Yulona does not meter credits. Your provider bills you directly; the token counts below help you estimate that.</AlertDescription></Alert>
        </StaggerItem>
      )}

      {!isAdmin ? <RoleNotice what="the usage breakdown" /> : (
        <>
          <StaggerItem>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-lg font-semibold">Breakdown</h2>
              <div role="group" aria-label="Date range" className="inline-flex rounded-lg bg-muted p-0.5">
                {RANGES.map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={`min-h-9 rounded-md px-3 text-sm font-medium ${days === d ? "bg-card shadow-sm" : "text-muted-foreground"}`}>{d} days</button>)}
              </div>
            </div>
          </StaggerItem>

          <StaggerItem>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Token totals">
              {day.isPending ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />) : (
                <>
                  <Card className="gap-1 p-4"><p className="text-sm text-muted-foreground">Total tokens</p><p className="font-display text-2xl font-semibold tabular-nums">{fmtNum(t?.totalTokens ?? 0)}</p></Card>
                  <Card className="gap-1 p-4"><p className="text-sm text-muted-foreground">Input tokens</p><p className="font-display text-2xl font-semibold tabular-nums">{fmtNum(t?.promptTokens ?? 0)}</p></Card>
                  <Card className="gap-1 p-4"><p className="text-sm text-muted-foreground">Output tokens</p><p className="font-display text-2xl font-semibold tabular-nums">{fmtNum(t?.completionTokens ?? 0)}</p></Card>
                  <Card className="gap-1 p-4"><p className="text-sm text-muted-foreground">Requests</p><p className="font-display text-2xl font-semibold tabular-nums">{fmtNum(t?.requests ?? 0)}</p></Card>
                </>
              )}
            </div>
          </StaggerItem>

          <StaggerItem>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-lg font-semibold">Daily usage</h2>
                {saas && (
                  <div role="group" aria-label="Chart metric" className="inline-flex rounded-lg bg-muted p-0.5">
                    {(["credits", "tokens"] as const).map((m) => <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)} className={`min-h-9 rounded-md px-3 text-sm font-medium capitalize ${metric === m ? "bg-card shadow-sm" : "text-muted-foreground"}`}>{m}</button>)}
                  </div>
                )}
              </div>
              {day.isPending ? <Skeleton className="h-40" /> : day.isError ? <ErrorState error={day.error} retry={() => void day.refetch()} />
                : <BarSeries data={series} label={useCreditsMetric ? "Credits per day" : "Tokens per day"} unit={useCreditsMetric ? " credits" : " tokens"} />}
            </Card>
          </StaggerItem>

          <StaggerItem>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                  <TabsList aria-label="Group usage">{TABS.map((x) => <TabsTrigger key={x.id} value={x.id}>{x.label}</TabsTrigger>)}</TabsList>
                </Tabs>
                <Button variant="outline" size="sm" disabled={exp.isPending} onClick={() => exp.mutate()}><Download aria-hidden />Export CSV</Button>
              </div>
              {group.isPending ? <div role="status" className="space-y-2"><span className="sr-only">Loading usage…</span>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
                : group.isError ? <ErrorState error={group.error} retry={() => void group.refetch()} />
                : group.data.items.length === 0 ? <Empty title="No AI usage in this period" body="Once your assistants answer customers, the agents, models and conversations that used the most show up here." action={<Button variant="outline" asChild><Link to="/agents">Open agents</Link></Button>} />
                : <Breakdown rows={group.data.items} groupBy={tab} credits={saas} nameLabel={TABS.find((x) => x.id === tab)!.name} />}
            </Card>
          </StaggerItem>
        </>
      )}
      {buy && <BuyCreditsDialog onClose={() => setBuy(false)} />}
    </Stagger>
  );
}
