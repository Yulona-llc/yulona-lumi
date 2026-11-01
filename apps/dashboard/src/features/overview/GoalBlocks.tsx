import { Link } from "react-router";
import { ArrowRight, CalendarCheck, Check, HelpCircle, MessageCircleQuestion, Plug, Sparkles, Target, Timer, UserRound } from "lucide-react";
import type { Goal, OverviewDto } from "@yulona/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/motion";
import { Funnel } from "./Funnel";
import { waitLabel } from "./api";

const STAGE_LABEL: Record<string, string> = { visitor: "Started", engaged: "Engaged", qualified: "Qualified", booking_offered: "Offered", booked: "Booked" };

function Kpi({ label, value, hint, suffix, icon: Icon, testId, format }: { label: string; value: number | null; hint?: string; suffix?: string; icon: typeof Target; testId?: string; format?: (n: number) => string }) {
  return (
    <div className="rounded-xl bg-muted p-3.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Icon className="size-4" aria-hidden />{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value === null ? "No data yet" : <><AnimatedNumber value={value} format={format} />{suffix}</>}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Block({ id, title, subtitle, children }: { id: string; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} data-testid={`block-${id}`}>
      <Card className="gap-4 p-5">
        <div><h2 id={`${id}-h`} className="font-display text-lg font-semibold">{title}</h2><p className="text-sm text-muted-foreground">{subtitle}</p></div>
        {children}
      </Card>
    </section>
  );
}

export function SupportBlock({ d }: { d: NonNullable<OverviewDto["support"]> }) {
  const sec = d.medianFirstResponseSeconds;
  return (
    <Block id="support" title="Customer questions" subtitle="How well Lumi answers on its own. Last 30 days.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi testId="kpi-resolved" label="Answered by Lumi" value={d.aiResolvedPct} suffix="%" format={(n) => String(Math.round(n * 10) / 10)} hint="Chats that never needed a person" icon={Check} />
        <Kpi testId="kpi-handoffs" label="Handed to your team" value={d.handoffs} icon={UserRound} />
        <Kpi testId="kpi-response" label="First reply" value={sec === null ? null : sec} suffix=" s" hint="Typical time to the first answer" icon={Timer} />
      </div>
      <div>
        <h3 className="flex items-center gap-1.5 font-sans text-sm font-semibold tracking-normal"><MessageCircleQuestion className="size-4" aria-hidden />Questions Lumi could not answer: {d.unanswered.count}</h3>
        {d.unanswered.count === 0 ? <p className="mt-1 text-sm text-muted-foreground">Nothing yet. When Lumi cannot find an answer, those chats show here so you can add the missing information.</p> : (
          <>
            <ul className="mt-2 divide-y rounded-xl border" aria-label="Unanswered questions">
              {d.unanswered.items.map((u) => (
                <li key={u.id}>{u.conversationId
                  ? <Link to={`/inbox/${u.conversationId}`} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-muted"><span>Chat from {waitLabel(u.createdAt)} ago</span><ArrowRight className="size-4 text-muted-foreground" aria-hidden /></Link>
                  : <span className="block px-3 py-2 text-sm">Chat from {waitLabel(u.createdAt)} ago</span>}</li>
              ))}
            </ul>
            <Button asChild variant="outline" size="sm" className="mt-3"><Link to="/knowledge">Add knowledge</Link></Button>
          </>
        )}
      </div>
    </Block>
  );
}

export function LeadsBlock({ d }: { d: NonNullable<OverviewDto["leads"]> }) {
  const steps = d.funnel.map((f) => ({ key: f.stage, label: STAGE_LABEL[f.stage] ?? f.stage, count: f.count }));
  const empty = steps.every((s) => s.count === 0);
  const h = d.hubspot;
  return (
    <Block id="leads" title="Leads" subtitle="From first message to qualified lead. Last 30 days.">
      {empty ? <p className="py-4 text-center text-sm text-muted-foreground">No conversations yet. When customers start chatting, the funnel fills in here.</p> : <Funnel steps={steps} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi testId="kpi-qualified" label="Qualified leads" value={d.qualified} icon={Target} />
        <div className="rounded-xl bg-muted p-3.5" data-testid="hubspot-status">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Plug className="size-4" aria-hidden />HubSpot</p>
          {h.connected ? (
            <p className="mt-1 text-sm">Connected{h.lastSyncAt ? <>, last synced {waitLabel(h.lastSyncAt)} ago</> : ", nothing synced yet"}.{h.failed > 0 && <span className="font-medium text-destructive"> {h.failed} failed to sync.</span>}</p>
          ) : <p className="mt-1 text-sm">Not connected. <Link to="/settings/integrations" className="font-medium underline underline-offset-4">Connect HubSpot</Link> to send qualified leads to your CRM.</p>}
        </div>
      </div>
    </Block>
  );
}

export function BookingsBlock({ d }: { d: NonNullable<OverviewDto["bookings"]> }) {
  return (
    <Block id="bookings" title="Bookings" subtitle="Appointments Lumi arranged for you. Booked and cancelled cover the last 30 days.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi testId="kpi-upcoming" label="Upcoming" value={d.upcoming} icon={CalendarCheck} />
        <Kpi testId="kpi-booked" label="Booked" value={d.booked30d} icon={Check} />
        <Kpi testId="kpi-cancelled" label="Cancelled" value={d.cancelled30d} icon={HelpCircle} />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="calendar-status">
        {d.calendar.connected ? <>Calendar connected{d.calendar.provider ? ` (${d.calendar.provider === "google" ? "Google Calendar" : "Calendly"})` : ""}.</> : <>No calendar connected yet. <Link to="/settings/integrations" className="font-medium text-foreground underline underline-offset-4">Connect a calendar</Link> so customers can book.</>}
      </p>
    </Block>
  );
}

/** Rendered when the workspace has no goal: the setup prompt that points to the wizard or Ask Lumi. */
export function NoGoal({ isAdmin, onboardingOpen, onPick, pending }: { isAdmin: boolean; onboardingOpen: boolean; onPick: (g: Goal[]) => void; pending: boolean }) {
  const goals: { g: Goal; label: string }[] = [{ g: "support", label: "Answer questions" }, { g: "leads", label: "Capture leads" }, { g: "bookings", label: "Take bookings" }];
  return (
    <Card className="gap-4 p-5" data-testid="no-goal">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground"><Sparkles className="size-5" aria-hidden /></span>
        <div><h2 className="font-display text-lg font-semibold">Tell Lumi your goal</h2><p className="text-sm text-muted-foreground">Your Overview then shows the numbers that matter for it, like answered questions, leads or bookings.</p></div>
      </div>
      {isAdmin ? (
        <>
          <div className="flex flex-wrap gap-2.5">{goals.map((x) => <Button key={x.g} variant="outline" disabled={pending} onClick={() => onPick([x.g])}>{x.label}</Button>)}</div>
          {onboardingOpen && <Button asChild className="w-fit"><Link to="/onboarding"><Sparkles />Set up with Lumi</Link></Button>}
        </>
      ) : <p className="text-sm text-muted-foreground">Ask a workspace admin to choose the goal.</p>}
    </Card>
  );
}

export const GOAL_BLOCKS: Record<Exclude<Goal, "other">, (o: OverviewDto) => React.ReactNode> = {
  support: (o) => o.support && <SupportBlock d={o.support} key="support" />,
  leads: (o) => o.leads && <LeadsBlock d={o.leads} key="leads" />,
  bookings: (o) => o.bookings && <BookingsBlock d={o.bookings} key="bookings" />,
};
