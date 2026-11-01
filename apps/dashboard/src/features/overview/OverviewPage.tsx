import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowRight, Bot, Check, Circle, Sparkles, UserRound } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/motion";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "../common/api";
import { ErrorState, PageHeader, useRole } from "../common/ui";
import { overviewApi, waitLabel } from "./api";
import { GOAL_BLOCKS, NoGoal } from "./GoalBlocks";
import { onboardingApi } from "../onboarding/api";
import { CreditAlerts, CreditsCard } from "../usage/CreditAlerts";
import { SparkCard, dailyValues } from "./Spark";

function Setup({ items, nextStep }: { items: { key: string; label: string; done: boolean; path: string }[]; nextStep?: { label: string; path: string } | null }) {
  const done = items.filter((s) => s.done).length;
  return (
    <Card className="gap-4 p-5" data-testid="setup-checklist">
      <div>
        <h2 className="font-display text-lg font-semibold">Set up your workspace</h2>
        <p className="text-sm text-muted-foreground">{done} of {items.length} done. Your first conversation appears here once a channel is live.</p>
      </div>
      {nextStep && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-accent/50 p-3" data-testid="try-then-publish">
          <Sparkles className="size-5 shrink-0 text-accent-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-sm font-medium">{nextStep.label}</p>
          <Button asChild size="sm"><Link to={`${nextStep.path}?tab=sandbox`}>Try it now</Link></Button>
        </div>
      )}
      <ol className="grid gap-3">
        {items.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-3 rounded-xl border bg-background p-3 sm:flex-nowrap">
            <span className={`grid size-8 shrink-0 place-items-center rounded-full ${s.done ? "bg-success text-white dark:text-[#06210f]" : "bg-accent text-accent-foreground"}`}>{s.done ? <Check className="size-4" aria-hidden /> : <Circle className="size-4" aria-hidden />}</span>
            <p className="min-w-0 flex-1 font-medium">{s.label}{s.done && <span className="sr-only"> (done)</span>}</p>
            {!s.done && <Button asChild size="sm" variant="outline" className="max-sm:ml-11 max-sm:w-[calc(100%-2.75rem)]"><Link to={s.path}>Open</Link></Button>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function OverviewPage() {
  const { session } = useAuth();
  const { atLeast, isAdmin } = useRole();
  const qc = useQueryClient();
  const [range, setRange] = useState<7 | 30>(30);
  const summary = useQuery({ queryKey: ["overview", "summary"], queryFn: overviewApi.summary, retry: false });
  const usage = useQuery({ queryKey: ["overview", "usage"], queryFn: () => overviewApi.usage(30) });
  const open = useQuery({ queryKey: ["overview", "open"], queryFn: () => overviewApi.conversations({ status: "open", limit: 100 }) });
  const pending = useQuery({ queryKey: ["overview", "pending"], queryFn: () => overviewApi.conversations({ status: "pending_human", limit: 100 }) });
  const attention = useQuery({ queryKey: ["overview", "attention"], queryFn: overviewApi.attention, enabled: atLeast("agent"), retry: false, refetchInterval: 30_000 });
  const onboarding = useQuery({ queryKey: ["onboarding"], queryFn: onboardingApi.state, enabled: isAdmin, retry: false, staleTime: 60_000 });
  const setGoals = useMutation({
    mutationFn: onboardingApi.setGoals,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["overview", "summary"] }); void qc.invalidateQueries({ queryKey: ["workspace-profile"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const first = session?.user.name?.split(" ")[0];
  const o = summary.data;
  const setupIncomplete = isAdmin && !!o && o.common.setup.doneCount < o.common.setup.total;
  const obStatus = onboarding.data?.status;
  const nextStep = onboarding.data?.result && o && !o.common.setup.items.find((i) => i.key === "publish")?.done ? onboarding.data.result.nextStep : null;
  const noGoal = !!o && o.goals.length === 0;
  // Before the first conversation the checklist leads; once chats flow, the numbers come first and the checklist follows.
  const setupFirst = !o || o.common.conversations.last30d === 0 || !!nextStep;

  const ai = (open.data ?? []).filter((c) => c.handler === "ai").length;
  const waiting = pending.data ?? [];
  const human = (open.data ?? []).filter((c) => c.handler === "human").length;
  const oldestIso = attention.data?.[0]?.createdAt ?? waiting.map((c) => c.lastCustomerMessageAt ?? c.lastMessageAt).sort()[0];
  const needs = (attention.data ?? []).slice(0, 5);

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl">
      <PageHeader title={first ? `Hello, ${first}` : "Overview"} subtitle="How conversations are turning into customers, and what needs a person right now." />
      <CreditAlerts className="mb-6" />
      {isAdmin && (obStatus === "not_started" || obStatus === "skipped" || obStatus === "in_progress") && !noGoal && (
        <Card className="mb-6 flex-row flex-wrap items-center gap-3 p-4" data-testid="setup-prompt">
          <Sparkles className="size-5 shrink-0 text-accent-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-sm"><strong>Finish your setup with Lumi.</strong> Answer a few questions and Lumi prepares an agent, chat window and hours for you.</p>
          <Button asChild size="sm"><Link to="/onboarding">{obStatus === "in_progress" ? "Continue setup" : "Start setup"}</Link></Button>
        </Card>
      )}
      {noGoal && <div className="mb-6"><NoGoal isAdmin={isAdmin} onboardingOpen={obStatus !== "completed"} pending={setGoals.isPending} onPick={(g) => setGoals.mutate(g)} /></div>}
      {setupIncomplete && o && setupFirst && <div className="mb-6"><Setup items={o.common.setup.items} nextStep={nextStep} /></div>}
      <div className={noGoal ? "grid grid-cols-[minmax(0,1fr)] gap-6" : "grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"}>
        {!noGoal && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
          {summary.isPending ? <Skeleton className="h-64" role="status" aria-label="Loading overview" />
            : summary.isError ? <ErrorState error={summary.error} retry={() => void summary.refetch()} />
            : noGoal ? null
            : o!.order.map((g) => GOAL_BLOCKS[g as "support" | "leads" | "bookings"]?.(o!))}
          {o && !noGoal && o.order.length === 0 && <p className="text-sm text-muted-foreground">Your goal is set to something else. Use Ask Lumi to tell Lumi more about it.</p>}
        </div>}
        <div className={noGoal ? "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6 md:grid-cols-2" : "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6"}>
          <CreditsCard />
          <section aria-labelledby="now-h">
            <Card className="gap-3 p-5" data-testid="right-now">
              <h2 id="now-h" className="font-display text-lg font-semibold">Right now</h2>
              {open.isPending || pending.isPending ? <Skeleton className="h-20" /> : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-muted p-3"><p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Bot className="size-4" aria-hidden />AI is handling</p><p className="font-display text-3xl font-semibold tabular-nums"><AnimatedNumber value={ai} /></p></div>
                    <div className={`rounded-xl p-3 ${waiting.length ? "bg-accent text-accent-foreground" : "bg-muted"}`}><p className="flex items-center gap-1.5 text-sm"><UserRound className="size-4" aria-hidden />Waiting for a person</p><p className="font-display text-3xl font-semibold tabular-nums"><AnimatedNumber value={waiting.length} /></p></div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {waiting.length ? <>Longest wait <strong className="text-foreground">{waitLabel(oldestIso)}</strong>.</> : "No one is waiting."}
                    {human > 0 && <> {human} with your team.</>}
                  </p>
                </>
              )}
            </Card>
          </section>
          {atLeast("agent") && (
            <section aria-labelledby="needs-h">
              <Card className="gap-3 p-5">
                <div className="flex items-center justify-between"><h2 id="needs-h" className="font-display text-lg font-semibold">Needs you</h2>{needs.length > 0 && <Link to="/attention" className="text-sm font-medium text-accent-foreground underline-offset-4 hover:underline">See all</Link>}</div>
                {attention.isPending ? <Skeleton className="h-16" /> : needs.length === 0 ? <p className="text-sm text-muted-foreground">Nothing needs a person. The AI has it covered.</p> : (
                  <ul className="-mx-2 divide-y">
                    {needs.map((h) => (
                      <li key={h.id}><Link to={`/inbox/${h.conversation.id}`} className="flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
                        <div className="min-w-0 flex-1"><p className="truncate font-medium">{h.contact.name ?? h.contact.email ?? h.contact.phone ?? "Unknown contact"}</p><p className="truncate text-sm text-muted-foreground">{h.summary ?? h.reason}</p></div>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{waitLabel(h.createdAt)}</span><ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link></li>))}
                  </ul>
                )}
              </Card>
            </section>
          )}
        </div>
      </div>
      {setupIncomplete && o && !setupFirst && <div className="mt-6"><Setup items={o.common.setup.items} nextStep={nextStep} /></div>}
      <section aria-labelledby="usage-h" className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="usage-h" className="font-display text-lg font-semibold">Activity</h2>
          <div role="group" aria-label="Date range" className="inline-flex rounded-lg bg-muted p-0.5">
            {([7, 30] as const).map((d) => <button key={d} type="button" aria-pressed={range === d} onClick={() => setRange(d)} className={`min-h-9 rounded-md px-3 text-sm font-medium ${range === d ? "bg-card shadow-sm" : "text-muted-foreground"}`}>{d} days</button>)}
          </div>
        </div>
        {usage.isError ? <ErrorState error={usage.error} retry={() => void usage.refetch()} /> : (
          <div className="grid gap-4 sm:grid-cols-3">
            {usage.isPending ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />) : (
              [["Conversations", "conversations"], ["Messages", "messages"], ["New contacts", "new_contacts"]].map(([l, m]) => <SparkCard key={m} label={l!} values={dailyValues(usage.data, m!, range)} days={range} />)
            )}
          </div>
        )}
      </section>
    </div>
  );
}
