import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { CalendarClock, ChevronLeft, ChevronRight, ExternalLink, MessageSquare, Plus, TriangleAlert, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { Empty, ErrorState, fmtDate, Loading, Modal, PageHeader, TextField, useRole } from "../common/ui";
import { useIsDesktop } from "../ops-settings/hooks";
import { Segmented } from "../ops-settings/Segmented";
import { label, ops, type Booking } from "../ops-settings/opsApi";
import CalendarStrip, { useCalendars } from "./CalendarStrip";
import NewBooking from "./NewBooking";

type View = "list" | "calendar";
const TONE = { booked: "success", cancelled: "secondary", failed: "destructive", offered: "secondary" } as const;
const time = (s: string) => new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const mins = (b: Booking) => Math.round((new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000);
const startOfWeek = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
const dayHeading = (d: Date) => {
  const today = new Date(); const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
  const base = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return diff === 0 ? `Today, ${base}` : diff === 1 ? `Tomorrow, ${base}` : base;
};

export default function BookingsPage() {
  const { atLeast } = useRole();
  const canWrite = atLeast("agent");
  const desktop = useIsDesktop();
  const qc = useQueryClient();
  const [view, setView] = useState<View>("list");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState(() => new Date());
  const [picked, setPicked] = useState(() => new Date());
  const [creating, setCreating] = useState(false);
  const [cancel, setCancel] = useState<Booking | null>(null);
  const month = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth(), 1), [cursor]);
  const week = useMemo(() => startOfWeek(cursor), [cursor]);
  const range = useMemo(() => {
    if (view !== "calendar") return {};
    return desktop
      ? { from: month.toISOString(), to: new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString() }
      : { from: week.toISOString(), to: new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7).toISOString() };
  }, [view, desktop, month, week]);
  const q = useQuery({ queryKey: ["bookings", status, range], queryFn: () => ops.bookings({ status: status || undefined, ...range }) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["bookings"] });
  const items = q.data?.items ?? [];
  const byDay = useMemo(() => { const m = new Map<string, Booking[]>(); for (const b of items) { const k = dayKey(new Date(b.startAt)); m.set(k, [...(m.get(k) ?? []), b]); } return m; }, [items]);
  const cals = useCalendars();
  // Admins know the connections: New booking needs at least one. Other roles cannot read them, so the server decides on submit.
  const noCalendar = cals.isAdmin && cals.q.isSuccess && cals.connected.length === 0;
  const waiting = cals.isAdmin && cals.q.isPending;
  const newBtn = canWrite && (
    <Button onClick={() => setCreating(true)} disabled={noCalendar || waiting} aria-describedby={noCalendar ? "new-booking-hint" : undefined}><Plus />New booking</Button>);

  return (
    <div className="space-y-5">
      <PageHeader title="Bookings" subtitle="Appointments booked by the AI or your team."
        actions={<><Segmented label="View" value={view} onChange={setView} options={[{ value: "list", label: "List", name: "List" }, { value: "calendar", label: "Calendar", name: "Calendar" }]} />{newBtn}</>} />
      <CalendarStrip calendars={cals} />
      {noCalendar && canWrite && <p id="new-booking-hint" className="-mt-2 text-sm text-muted-foreground">Connect a calendar above to create bookings.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented scroll label="Status" value={status} onChange={setStatus} options={[{ value: "", label: "All" }, { value: "booked", label: "Booked" }, { value: "cancelled", label: "Cancelled" }, { value: "failed", label: "Failed" }]} />
        {view === "calendar" && (
          <div className="flex items-center gap-1" role="group" aria-label={desktop ? "Month" : "Week"}>
            <Button variant="outline" size="icon" aria-label={desktop ? "Previous month" : "Previous week"} onClick={() => setCursor(desktop ? new Date(month.getFullYear(), month.getMonth() - 1, 1) : new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7))}><ChevronLeft /></Button>
            <span className="min-w-36 text-center font-display font-semibold" aria-live="polite">{desktop ? month.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : `${week.toLocaleDateString(undefined, { month: "short", day: "numeric" })} to ${new Date(week.getFullYear(), week.getMonth(), week.getDate() + 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}</span>
            <Button variant="outline" size="icon" aria-label={desktop ? "Next month" : "Next week"} onClick={() => setCursor(desktop ? new Date(month.getFullYear(), month.getMonth() + 1, 1) : new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7))}><ChevronRight /></Button>
          </div>)}
      </div>
      {q.isPending ? <Loading label="Loading bookings" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : view === "list" ? (
        items.length === 0 ? <Empty icon={<CalendarClock className="size-6" />} title="No bookings yet" body="Bookings made by the AI assistant or by your team appear here." action={newBtn} /> : <Agenda items={items} canWrite={canWrite} onCancel={setCancel} />
      ) : desktop ? <MonthGrid month={month} byDay={byDay} onPick={setCancel} /> : (
        <WeekStrip week={week} picked={picked} setPicked={setPicked} byDay={byDay} canWrite={canWrite} onCancel={setCancel} />
      )}
      {creating && <NewBooking providers={cals.known ? cals.connected.map((c) => c.provider) : []} defaultProvider={cals.defaultProvider} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
      {cancel && <CancelBooking b={cancel} canWrite={canWrite} onClose={() => setCancel(null)} onDone={() => { setCancel(null); refresh(); }} />}
    </div>
  );
}

function BookingRow({ b, canWrite, onCancel }: { b: Booking; canWrite: boolean; onCancel: (b: Booking) => void }) {
  const off = b.status !== "booked";
  return (
    <div className={cn("flex gap-3 rounded-xl border bg-card p-3.5", off && "bg-card/60")}>
      <div className="w-[4.5rem] shrink-0 text-center">
        <p className={cn("whitespace-nowrap font-display text-base font-semibold leading-tight tabular-nums", off && "text-muted-foreground line-through")}>{time(b.startAt)}</p>
        <p className="text-xs text-muted-foreground">{mins(b)} min</p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><p className="truncate font-medium">{b.title}</p><Badge variant={TONE[b.status]}>{label(b.status)}</Badge></div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span>{b.contactName ?? b.attendeeEmail ?? "No contact"}</span>
          {b.conversationId && <Link className="inline-flex items-center gap-1 text-accent-foreground hover:underline" to={`/inbox/${b.conversationId}`}><MessageSquare className="size-3.5" />Conversation</Link>}
          {b.eventUrl && <a className="inline-flex items-center gap-1 text-accent-foreground hover:underline" href={b.eventUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" />Open in calendar<span className="sr-only"> (new tab)</span></a>}
        </p>
        {b.failureReason && <p className="mt-1 flex items-start gap-1.5 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{b.failureReason}</p>}
      </div>
      {canWrite && b.status === "booked" && <Button variant="outline" size="sm" className="self-start" onClick={() => onCancel(b)}>Cancel<span className="sr-only"> {b.title}</span></Button>}
    </div>
  );
}

function Agenda({ items, canWrite, onCancel }: { items: Booking[]; canWrite: boolean; onCancel: (b: Booking) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of [...items].sort((a, c) => a.startAt.localeCompare(c.startAt))) { const k = dayKey(new Date(b.startAt)); m.set(k, [...(m.get(k) ?? []), b]); }
    return [...m.values()];
  }, [items]);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g[0]!.id} aria-label={dayHeading(new Date(g[0]!.startAt))}>
          <h2 className="mb-2 font-display text-sm font-semibold text-muted-foreground">{dayHeading(new Date(g[0]!.startAt))}</h2>
          <ul className="space-y-2">{g.map((b) => <li key={b.id}><BookingRow b={b} canWrite={canWrite} onCancel={onCancel} /></li>)}</ul>
        </section>))}
    </div>
  );
}

/** Phones: seven day buttons, the chosen day's agenda below. */
function WeekStrip({ week, picked, setPicked, byDay, canWrite, onCancel }: { week: Date; picked: Date; setPicked: (d: Date) => void; byDay: Map<string, Booking[]>; canWrite: boolean; onCancel: (b: Booking) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(week.getFullYear(), week.getMonth(), week.getDate() + i));
  const sel = days.find((d) => dayKey(d) === dayKey(picked)) ?? days[0]!;
  const todays = (byDay.get(dayKey(sel)) ?? []).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const today = dayKey(new Date());
  return (
    <div>
      <div role="group" aria-label="Days of the week" className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const n = byDay.get(dayKey(d))?.length ?? 0, on = dayKey(d) === dayKey(sel);
          return (
            <button key={d.toISOString()} type="button" aria-pressed={on} aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${n} booking${n === 1 ? "" : "s"}`} onClick={() => setPicked(d)}
              className={cn("relative flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl border text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30", on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted", dayKey(d) === today && !on && "border-primary/60")}>
              <span className={cn("text-[11px]", on ? "text-primary-foreground/80" : "text-muted-foreground")}>{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="font-display text-lg font-semibold leading-none tabular-nums">{d.getDate()}</span>
              <span className="flex h-1.5 gap-0.5" aria-hidden="true">{Array.from({ length: Math.min(n, 3) }, (_, i) => <span key={i} className={cn("size-1.5 rounded-full", on ? "bg-primary-foreground" : "bg-primary")} />)}</span>
            </button>);
        })}
      </div>
      <h2 className="mb-2 mt-5 font-display text-sm font-semibold text-muted-foreground">{dayHeading(sel)}</h2>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={dayKey(sel)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          {todays.length === 0 ? <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">Nothing booked this day.</p> : <ul className="space-y-2">{todays.map((b) => <li key={b.id}><BookingRow b={b} canWrite={canWrite} onCancel={onCancel} /></li>)}</ul>}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function MonthGrid({ month, byDay, onPick }: { month: Date; byDay: Map<string, Booking[]>; onPick: (b: Booking) => void }) {
  const lead = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => (i < lead || i >= lead + days ? null : i - lead + 1));
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = dayKey(new Date());
  return (
    <div role="grid" aria-label="Bookings calendar" className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border bg-border">
      {names.map((n) => <div key={n} role="columnheader" className="bg-muted p-2 text-xs font-semibold text-muted-foreground">{n}</div>)}
      {cells.map((d, i) => {
        const key = d ? dayKey(new Date(month.getFullYear(), month.getMonth(), d)) : "";
        const bs = d ? byDay.get(key) ?? [] : [];
        return (
          <div key={i} role="gridcell" className={cn("min-h-28 p-1.5", d ? "bg-card" : "bg-muted/40")}>
            {d && <p className={cn("mb-1 grid size-6 place-items-center rounded-full text-xs tabular-nums", key === today ? "bg-primary font-bold text-primary-foreground" : "text-muted-foreground")}>{d}</p>}
            <ul className="space-y-1">{bs.map((b) => (
              <li key={b.id}><button onClick={() => onPick(b)} className={cn("w-full truncate rounded-md px-1.5 py-1 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", b.status === "booked" ? "bg-primary/15 text-accent-foreground" : b.status === "failed" ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground line-through")}>{time(b.startAt)} {b.title}</button></li>))}</ul>
          </div>);
      })}
    </div>
  );
}

function CancelBooking({ b, canWrite, onClose, onDone }: { b: Booking; canWrite: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => ops.cancelBooking(b.id, reason.trim() || undefined),
    onSuccess: () => { toast.success("Booking cancelled", { description: b.title }); onDone(); },
    onError: (e) => toast.error("Could not cancel booking", { description: errMsg(e) }),
  });
  const cancellable = canWrite && b.status === "booked";
  return (
    <Modal title={b.title} onClose={onClose}>
      <p className="flex flex-wrap items-center gap-2 text-sm">{fmtDate(b.startAt)} to {time(b.endAt)}<Badge variant={TONE[b.status]}>{label(b.status)}</Badge></p>
      {b.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{b.notes}</p>}
      {b.failureReason && <p className="mt-2 text-sm text-destructive">{b.failureReason}</p>}
      {cancellable ? (
        <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <TextField label="Cancellation reason (optional)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Keep booking</Button><Button variant="destructive" disabled={m.isPending}><X />Cancel booking</Button></div>
        </form>
      ) : <div className="mt-4 text-right"><Button variant="outline" onClick={onClose}>Close</Button></div>}
    </Modal>
  );
}
