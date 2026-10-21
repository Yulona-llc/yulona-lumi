import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowRight, BookOpen, Bot, Check, Radio, UserRound } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/motion";
import { ErrorState, PageHeader, useRole } from "../common/ui";
import { buildFunnel, overviewApi, waitLabel } from "./api";
import { Funnel } from "./Funnel";
import { CreditAlerts, CreditsCard } from "../usage/CreditAlerts";
import { SparkCard, dailyValues } from "./Spark";

const DAY = 86_400_000;

function Setup({ steps }: { steps: Array<{ done: boolean; title: string; body: string; to: string; cta: string; icon: typeof Bot }> }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Card className="gap-4 p-5" data-testid="setup-checklist">
      <div>
        <h2 className="font-display text-lg font-semibold">Set up your workspace</h2>
        <p className="text-sm text-muted-foreground">{done} of {steps.length} done. Your first conversation appears here once a channel is live.</p>
      </div>
      <ol className="grid gap-3">
        {steps.map((s) => (
          <li key={s.title} className="flex flex-wrap items-start gap-3 rounded-xl border bg-background p-3 sm:flex-nowrap">
            <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${s.done ? "bg-success text-white dark:text-[#06210f]" : "bg-accent text-accent-foreground"}`}>{s.done ? <Check className="size-4" aria-hidden /> : <s.icon className="size-4" aria-hidden />}</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{s.title}{s.done && <span className="sr-only"> (done)</span>}</p>
              <p className="text-sm text-muted-foreground">{s.body}</p>
            </div>
            {!s.done && <Button asChild size="sm" variant="outline" className="max-sm:ml-11 max-sm:w-[calc(100%-2.75rem)]"><Link to={s.to}>{s.cta}</Link></Button>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function OverviewPage() {
  const { session } = useAuth();
  const { atLeast } = useRole();
  const [range, setRange] = useState<7 | 30>(30);
  const usage = useQuery({ queryKey: ["overview", "usage"], queryFn: () => overviewApi.usage(30) });
  const open = useQuery({ queryKey: ["overview", "open"], queryFn: () => overviewApi.conversations({ status: "open", limit: 100 }) });
  const pending = useQuery({ queryKey: ["overview", "pending"], queryFn: () => overviewApi.conversations({ status: "pending_human", limit: 100 }) });
  const recent = useQuery({ queryKey: ["overview", "recent"], queryFn: () => overviewApi.conversations({ limit: 100 }) });
  const bookings = useQuery({ queryKey: ["overview", "bookings"], queryFn: overviewApi.bookings, retry: false });
  const attention = useQuery({ queryKey: ["overview", "attention"], queryFn: overviewApi.attention, enabled: atLeast("agent"), retry: false, refetchInterval: 30_000 });
  const isAdmin = atLeast("admin");
  const agents = useQuery({ queryKey: ["overview", "agents"], queryFn: overviewApi.agents, enabled: isAdmin, retry: false });
  const sources = useQuery({ queryKey: ["overview", "sources"], queryFn: overviewApi.sources, enabled: isAdmin, retry: false });
  const channels = useQuery({ queryKey: ["overview", "channels"], queryFn: overviewApi.channels, enabled: isAdmin, retry: false });
  const widgets = useQuery({ queryKey: ["overview", "widgets"], queryFn: overviewApi.widgets, enabled: isAdmin, retry: false });

  const first = session?.user.name?.split(" ")[0];
  const setupReady = isAdmin && agents.isSuccess && sources.isSuccess && (channels.isSuccess || widgets.isSuccess);
  const steps = setupReady ? [
    { done: agents.data!.length > 0, title: "Create an agent", body: "Give your AI a name, a voice and its instructions.", to: "/agents", cta: "Create agent", icon: Bot },
    { done: sources.data!.some((s) => s.status === "ready"), title: "Add knowledge", body: "Upload a document or point it at a web page so answers are grounded in your facts.", to: "/knowledge", cta: "Add knowledge", icon: BookOpen },
    { done: (channels.data?.length ?? 0) + (widgets.data?.length ?? 0) > 0, title: "Connect a channel", body: "Put the chat widget on your site or connect WhatsApp, Telegram and more.", to: "/channels", cta: "Connect channel", icon: Radio },
  ] : [];
  const setupIncomplete = steps.some((s) => !s.done);

  const sample = recent.data ?? [];
  const funnel = buildFunnel(sample, bookings.data ?? [], Date.now() - 30 * DAY);
  const noTraffic = recent.isSuccess && sample.length === 0;

  const ai = (open.data ?? []).filter((c) => c.handler === "ai").length;
  const waiting = pending.data ?? [];
  const human = (open.data ?? []).filter((c) => c.handler === "human").length;
  const oldestIso = attention.data?.[0]?.createdAt ?? waiting.map((c) => c.lastCustomerMessageAt ?? c.lastMessageAt).sort()[0];
  const needs = (attention.data ?? []).slice(0, 5);

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl">
      <PageHeader title={first ? `Hello, ${first}` : "Overview"} subtitle="How conversations are turning into customers, and what needs a person right now." />
      <CreditAlerts className="mb-6" />
      {setupIncomplete && <div className="mb-6"><Setup steps={steps} /></div>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section aria-labelledby="funnel-h" className="min-w-0">
          <Card className="gap-4 p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="funnel-h" className="font-display text-lg font-semibold">From first message to booking</h2>
              <p className="text-xs text-muted-foreground">Latest {Math.min(sample.length, 100) || 100} chats</p>
            </div>
            {recent.isPending ? <div className="space-y-2" role="status" aria-label="Loading funnel">{[100, 75, 50, 30].map((w) => <Skeleton key={w} className="mx-auto h-14" style={{ width: `${w}%` }} />)}</div>
              : recent.isError ? <ErrorState error={recent.error} retry={() => void recent.refetch()} />
              : noTraffic ? <p className="py-6 text-center text-sm text-muted-foreground">No conversations yet. When customers start chatting, the funnel fills in here.</p>
              : <Funnel steps={funnel} />}
          </Card>
        </section>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6">
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
