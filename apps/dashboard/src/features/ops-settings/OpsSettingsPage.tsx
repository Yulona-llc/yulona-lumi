import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Bot, CalendarOff, Copy, MessageSquareText, Plus, Trash2, UserCheck, Users, Flag, ListChecks } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthProvider";
import { errMsg } from "../common/api";
import { ErrorState, Loading, RoleNotice, Select, TextArea, TextField, useRole } from "../common/ui";
import { initials } from "./hooks";
import { label, ops, type Availability, type OpsSettings } from "./opsApi";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const STATUS_DOT: Record<Availability, string> = { online: "bg-[#25d366]", away: "bg-warning", offline: "bg-muted-foreground/50" };
const zones = (): string[] => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"]; } catch { return ["UTC"]; } };

export default function OpsSettingsPage() {
  const { isAdmin } = useRole();
  return (
    <div className="space-y-10">
      <AvailabilityCard />
      <HoursCard canEdit={isAdmin} />
    </div>
  );
}

function AvailabilityCard() {
  const me = useAuth().session?.user.id;
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ["availability"], queryFn: ops.team, refetchInterval: 30_000 });
  const set = useMutation({
    mutationFn: (s: Availability) => ops.setMyStatus(s),
    onSuccess: (_r, s) => { toast.success(`You are ${s}`); void qc.invalidateQueries({ queryKey: ["availability"] }); },
    onError: (e) => toast.error("Could not update your status", { description: errMsg(e) }),
  });
  const mine = team.data?.find((u) => u.userId === me)?.status;
  return (
    <section aria-labelledby="av">
      <h2 id="av" className="font-display text-lg font-semibold">Team availability</h2>
      <p className="mb-3 text-sm text-muted-foreground">Set yourself online to receive handoffs when routing is set to least busy.</p>
      <div role="radiogroup" aria-label="My status" className="mb-4 grid grid-cols-3 gap-2 sm:inline-grid">
        {(["online", "away", "offline"] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={mine === s} disabled={set.isPending} onClick={() => set.mutate(s)}
            className={cn("flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium capitalize outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30", mine === s ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted")}>
            <span aria-hidden="true" className={cn("size-2.5 rounded-full", STATUS_DOT[s])} />{s}
          </button>))}
      </div>
      {team.isPending ? <Loading rows={2} /> : team.isError ? <ErrorState error={team.error} retry={() => void team.refetch()} /> : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{team.data.map((u) => (
          <li key={u.userId}>
            <Card className="flex-row items-center gap-3 p-3">
              <span className="relative"><Avatar className="size-10"><AvatarFallback>{initials(u.name)}</AvatarFallback></Avatar><span aria-hidden="true" className={cn("absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card", STATUS_DOT[u.status])} /></span>
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{u.name}{u.userId === me && " (you)"}</p><p className="whitespace-nowrap text-xs text-muted-foreground">{label(u.role)} · {u.openConversations} open</p></div>
              <Badge variant={u.status === "online" ? "success" : u.status === "away" ? "warning" : "secondary"} className="hidden capitalize sm:inline-flex">{u.status}</Badge>
            </Card>
          </li>))}</ul>)}
    </section>
  );
}

type Win = { weekday: number; start: string; end: string };
const OOH = [
  { value: "ai_only", title: "AI only", body: "The AI keeps answering, nothing special.", icon: Bot },
  { value: "message", title: "AI sends a message", body: "The AI tells customers when you are back.", icon: MessageSquareText },
  { value: "queue", title: "Flag in the queue", body: "Handoffs are marked out of hours.", icon: Flag },
] as const;
const ASSIGN = [
  { value: "manual", title: "Manual claim", body: "Anyone on the team can claim a handoff.", icon: ListChecks },
  { value: "least_busy", title: "Least busy online agent", body: "Handoffs go to the free person first.", icon: UserCheck },
] as const;

function RadioCards<T extends string>({ name, value, onChange, options, disabled }: { name: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; title: string; body: string; icon: React.ComponentType<{ className?: string }> }>; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-2">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}
          className={cn("flex items-start gap-3 rounded-xl border bg-card p-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-60", value === o.value ? "border-primary bg-accent/70" : "hover:bg-muted/60")}>
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", value === o.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}><o.icon className="size-4" /></span>
          <span><span className="block text-sm font-semibold">{o.title}</span><span className="block text-sm text-muted-foreground">{o.body}</span></span>
        </button>))}
    </div>
  );
}

function HoursCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ops-settings"], queryFn: ops.settings });
  const [s, setS] = useState<OpsSettings | null>(null);
  const [holiday, setHoliday] = useState("");
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: () => ops.saveSettings(s!),
    onSuccess: (r) => { setS(r); toast.success("Settings saved"); void qc.invalidateQueries({ queryKey: ["ops-settings"] }); },
    onError: (e) => toast.error("Could not save settings", { description: errMsg(e) }),
  });
  const dirty = useMemo(() => !!(s && q.data && JSON.stringify(s) !== JSON.stringify(q.data)), [s, q.data]);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!s) return null;
  const dis = !canEdit;
  const setWin = (w: Win[]) => setS({ ...s, businessHours: w });
  const copyTo = (from: number, src: Win[], targets: number[]) => {
    const t = targets.filter((k) => k !== from);
    setWin([...s.businessHours.filter((w) => !t.includes(w.weekday)), ...t.flatMap((k) => src.map((w) => ({ ...w, weekday: k })))]);
  };
  const bad = s.businessHours.some((w) => w.start >= w.end);
  const openDays = new Set(s.businessHours.map((w) => w.weekday));

  return (
    <form aria-labelledby="bh" onSubmit={(e) => { e.preventDefault(); if (!bad) save.mutate(); }} className="space-y-8 pb-20">
      <div><h2 id="bh" className="font-display text-lg font-semibold">Business hours and routing</h2><p className="text-sm text-muted-foreground">With no windows configured you are treated as always open.</p></div>
      {dis && <RoleNotice what="changing these settings" />}
      <fieldset disabled={dis} className="space-y-8">
        <div className="max-w-sm"><Select label="Timezone" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>{[...new Set([s.timezone, ...zones()])].map((z) => <option key={z}>{z}</option>)}</Select></div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2"><h3 className="font-display text-base font-semibold">Weekly windows</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => setWin([1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" })))}>Weekdays 9 to 5</Button></div>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {ORDER.map((wd) => {
              const d = DAYS[wd]!;
              const ws = s.businessHours.map((w, i) => ({ w, i })).filter((x) => x.w.weekday === wd);
              const isOpen = openDays.has(wd);
              return (
                <li key={d} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex items-center gap-3 sm:w-40 sm:pt-1.5">
                    <Switch aria-label={`${d} open`} checked={isOpen} onCheckedChange={(v) => setWin(v ? [...s.businessHours, { weekday: wd, start: "09:00", end: "17:00" }] : s.businessHours.filter((w) => w.weekday !== wd))} />
                    <span className="w-24 font-medium">{d}</span>
                    {!isOpen && <span className="text-sm text-muted-foreground sm:hidden">Closed</span>}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    {!isOpen && <p className="hidden pt-1.5 text-sm text-muted-foreground sm:block">Closed</p>}
                    <AnimatePresence initial={false}>
                      {ws.map(({ w, i }) => (
                        <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-wrap items-center gap-2 overflow-hidden">
                          <label className="sr-only" htmlFor={`s${i}`}>{d} start</label><Input id={`s${i}`} type="time" className="w-32" value={w.start} onChange={(e) => setWin(s.businessHours.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                          <span aria-hidden="true" className="text-muted-foreground">to</span>
                          <label className="sr-only" htmlFor={`e${i}`}>{d} end</label><Input id={`e${i}`} type="time" className="w-32" aria-invalid={w.start >= w.end || undefined} value={w.end} onChange={(e) => setWin(s.businessHours.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${d} window ${w.start}`} onClick={() => setWin(s.businessHours.filter((_, j) => j !== i))}><Trash2 /></Button>
                        </motion.div>))}
                    </AnimatePresence>
                  </div>
                  {isOpen && (
                    <div className="flex gap-1 sm:pt-0.5">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setWin([...s.businessHours, { weekday: wd, start: "13:00", end: "17:00" }])}><Plus />Add window<span className="sr-only"> for {d}</span></Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="sm" aria-label={`Copy ${d} hours`}><Copy />Copy</Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => { copyTo(wd, ws.map((x) => x.w), [0, 1, 2, 3, 4, 5, 6]); toast.success(`${d} hours copied to every day`); }}>To all days</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => { copyTo(wd, ws.map((x) => x.w), [1, 2, 3, 4, 5]); toast.success(`${d} hours copied to weekdays`); }}>To weekdays</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>)}
                </li>);
            })}
          </ul>
          {bad && <p role="alert" className="mt-2 text-sm text-destructive">Each window must end after it starts.</p>}
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-3">
            <h3 className="font-display text-base font-semibold">Outside business hours</h3>
            <RadioCards name="Outside business hours" disabled={dis} value={s.outOfHours.mode} onChange={(v) => setS({ ...s, outOfHours: { ...s.outOfHours, mode: v } })} options={OOH} />
            {s.outOfHours.mode === "message" && <TextArea label="Out-of-hours message" rows={2} maxLength={500} value={s.outOfHours.message ?? ""} onChange={(e) => setS({ ...s, outOfHours: { ...s.outOfHours, message: e.target.value || null } })} />}
          </div>
          <div className="space-y-3">
            <h3 className="font-display text-base font-semibold">Handoff assignment</h3>
            <RadioCards name="Handoff assignment" disabled={dis} value={s.assignment.mode} onChange={(v) => setS({ ...s, assignment: { mode: v } })} options={ASSIGN} />
          </div>
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold">Ticket SLA <span className="text-sm font-normal text-muted-foreground">(minutes to resolve)</span></h3>
          <div className="grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
            {(["urgent", "high", "normal", "low"] as const).map((p) => <TextField key={p} label={label(p)} type="number" inputMode="numeric" min={1} value={s.slaMinutes[p]} onChange={(e) => setS({ ...s, slaMinutes: { ...s.slaMinutes, [p]: Math.max(1, Number(e.target.value) || 1) } })} />)}
          </div>
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold">Holidays</h3>
          <div className="flex max-w-sm items-end gap-2"><div className="flex-1"><TextField label="Add a date" type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} /></div><Button type="button" variant="outline" disabled={!holiday || s.holidays.includes(holiday)} onClick={() => { setS({ ...s, holidays: [...s.holidays, holiday].sort() }); setHoliday(""); }}><Plus />Add</Button></div>
          {s.holidays.length === 0 ? <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><CalendarOff className="size-4" />No holidays set. Closed days you add here override the weekly windows.</p> : (
            <ul className="mt-3 flex flex-wrap gap-2">{s.holidays.map((h) => (
              <li key={h}><Badge variant="secondary" className="gap-1.5 py-1 pl-3 pr-1.5 text-sm">{new Date(`${h}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                <button type="button" className="grid size-6 place-items-center rounded-full hover:bg-foreground/10" aria-label={`Remove holiday ${h}`} onClick={() => setS({ ...s, holidays: s.holidays.filter((x) => x !== h) })}>×</button></Badge></li>))}</ul>)}
        </div>
      </fieldset>
      <AnimatePresence>
        {canEdit && dirty && (
          <motion.div initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="fixed inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border bg-sidebar p-2.5 pl-4 text-sidebar-foreground shadow-2xl md:bottom-6">
            <Users className="hidden size-4 sm:block" aria-hidden="true" /><p className="flex-1 text-sm font-medium">Unsaved changes</p>
            <Button type="button" variant="ghost" className="text-sidebar-foreground hover:bg-white/10 hover:text-white" onClick={() => setS(q.data!)}>Discard</Button>
            <Button disabled={save.isPending || bad}>{save.isPending ? "Saving…" : "Save settings"}</Button>
          </motion.div>)}
      </AnimatePresence>
    </form>
  );
}
