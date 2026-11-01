import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { ErrorState, Loading, Modal, Select, TextArea, TextField } from "../common/ui";
import { Segmented } from "../ops-settings/Segmented";
import { ops, type Booking, type CalendarProviderKey } from "../ops-settings/opsApi";
import CopyButton from "./CopyButton";
import { PROVIDER_LABEL } from "./CalendarStrip";

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Provider-aware booking form. `providers` are the connected calendars (empty when the role cannot read them: the server then
 * uses the workspace default). Google books any free time; Calendly offers real open slots and needs the attendee's email.
 */
export default function NewBooking({ providers, defaultProvider, onClose, onCreated }: {
  providers: CalendarProviderKey[]; defaultProvider: CalendarProviderKey | null; onClose: () => void; onCreated: () => void;
}) {
  const initial: CalendarProviderKey | null = providers.length ? (defaultProvider && providers.includes(defaultProvider) ? defaultProvider : providers[0]!) : defaultProvider;
  const [provider, setProvider] = useState<CalendarProviderKey | null>(initial);
  const [offered, setOffered] = useState<Booking | null>(null);
  const title = offered ? "Send this scheduling link" : "New booking";
  return (
    <Modal title={title} onClose={onClose}>
      {offered ? <OfferedLink b={offered} onDone={onCreated} /> : (
        <div className="space-y-3">
          {providers.length > 1 && provider && (
            <Segmented label="Calendar" value={provider} onChange={setProvider} options={providers.map((p) => ({ value: p, label: PROVIDER_LABEL[p], name: PROVIDER_LABEL[p] }))} />)}
          {provider === "calendly"
            ? <CalendlyForm onClose={onClose} onCreated={onCreated} onOffered={setOffered} />
            : <GoogleForm provider={provider} onClose={onClose} onCreated={onCreated} />}
        </div>)}
    </Modal>
  );
}

function Actions({ onClose, disabled, label }: { onClose: () => void; disabled: boolean; label: string }) {
  return <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={disabled}>{label}</Button></div>;
}

function GoogleForm({ provider, onClose, onCreated }: { provider: CalendarProviderKey | null; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ title: "", start: "", duration: "30", email: "", notes: "" });
  const m = useMutation({
    mutationFn: () => ops.createBooking({
      startAt: new Date(f.start).toISOString(), durationMinutes: Number(f.duration), ...(provider ? { provider } : {}),
      ...(f.title ? { title: f.title } : {}), ...(f.email ? { attendeeEmail: f.email } : {}), ...(f.notes ? { notes: f.notes } : {}),
    }),
    onSuccess: () => { toast.success("Booking created"); onCreated(); },
    onError: (e) => toast.error("Could not create booking", { description: errMsg(e) }),
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (f.start) m.mutate(); }}>
      {provider === "google" && <p className="text-sm text-muted-foreground">Pick any time that is free on your Google calendar.</p>}
      <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Start" type="datetime-local" required value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
        <Select label="Duration" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })}>{[15, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{d} minutes</option>)}</Select>
      </div>
      <TextField label="Attendee email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <TextArea label="Notes" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      <Actions onClose={onClose} disabled={!f.start || m.isPending} label="Create booking" />
    </form>
  );
}

function CalendlyForm({ onClose, onCreated, onOffered }: { onClose: () => void; onCreated: () => void; onOffered: (b: Booking) => void }) {
  const [day, setDay] = useState(() => ymd(new Date()));
  const [slot, setSlot] = useState<{ start: string; end: string } | null>(null);
  const [f, setF] = useState({ title: "", email: "", notes: "" });
  const range = useMemo(() => {
    const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
    const from = new Date(y, mo - 1, d);
    const start = new Date(Math.max(from.getTime(), Date.now() + 5 * 60_000));
    return { from: start.toISOString(), to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7).toISOString() };
  }, [day]);
  const q = useQuery({ queryKey: ["booking-slots", "calendly", range], queryFn: () => ops.bookingSlots({ ...range, provider: "calendly", timezone: tz() }) });
  const byDay = useMemo(() => {
    const m = new Map<string, { start: string; end: string }[]>();
    for (const s of q.data?.slots ?? []) { const k = ymd(new Date(s.start)); m.set(k, [...(m.get(k) ?? []), s]); }
    return [...m.entries()];
  }, [q.data]);
  const m = useMutation({
    mutationFn: () => ops.createBooking({ startAt: slot!.start, provider: "calendly", attendeeEmail: f.email.trim(), timezone: tz(), ...(f.title ? { title: f.title } : {}), ...(f.notes ? { notes: f.notes } : {}) }),
    onSuccess: (b) => { if (b.status === "offered") { onOffered(b); return; } toast.success("Booking created"); onCreated(); },
    onError: (e) => toast.error("Could not create booking", { description: errMsg(e) }),
  });
  const ready = !!slot && /^\S+@\S+\.\S+$/.test(f.email.trim());
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <p className="text-sm text-muted-foreground">Choose one of the open times from your Calendly event type. Calendly sets the length of the meeting.</p>
      <TextField label="Show times from" type="date" value={day} min={ymd(new Date())} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setSlot(null); } }} />
      <div aria-label="Available times" className="max-h-56 space-y-3 overflow-y-auto rounded-xl border p-3">
        {q.isPending ? <Loading label="Loading open times" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : byDay.length === 0 ? <p className="text-sm text-muted-foreground">No open times in these 7 days. Try a later date.</p> : byDay.map(([k, slots]) => (
          <div key={k}>
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{dayLabel(new Date(slots[0]!.start))}</p>
            <div role="radiogroup" aria-label={dayLabel(new Date(slots[0]!.start))} className="flex flex-wrap gap-1.5">
              {slots.map((s) => {
                const on = slot?.start === s.start;
                return <button key={s.start} type="button" role="radio" aria-checked={on} onClick={() => setSlot(s)}
                  className={cn("min-h-9 rounded-lg border px-3 text-sm tabular-nums outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30", on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>{hhmm(new Date(s.start))}</button>;
              })}
            </div>
          </div>))}
      </div>
      <TextField label="Attendee email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} hint="Calendly sends the invitation to this address." />
      <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <TextArea label="Notes" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      <Actions onClose={onClose} disabled={!ready || m.isPending} label="Create booking" />
    </form>
  );
}

/** The Calendly Free plan cannot create events through the API: Calendly returns a single-use link the customer opens to pick the time. */
function OfferedLink({ b, onDone }: { b: Booking; onDone: () => void }) {
  const url = b.eventUrl ?? "";
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-sm"><Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />Your Calendly plan cannot create the meeting directly, so no booking exists yet. Send this single-use link to {b.attendeeEmail ?? "the customer"}; the meeting is booked when they open it and confirm.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input readOnly aria-label="Scheduling link" value={url} className="field min-w-0 flex-1 text-sm" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton value={url} label="Copy scheduling link" />
      </div>
      <div className="text-right"><Button onClick={onDone}>Done</Button></div>
    </div>
  );
}
