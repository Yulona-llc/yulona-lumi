import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { CalendarCheck, CalendarX2, CheckCircle2, Link2Off, RefreshCw, TriangleAlert, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ApiError } from "../../api/client";
import { errMsg } from "../common/api";
import { ConfirmModal, ErrorState, fmtDate, PageHeader, Select, TextField, useRole } from "../common/ui";
import { ops, type CalendarProviderKey, type CalendarProviderState } from "../ops-settings/opsApi";

const LABEL: Record<CalendarProviderKey, string> = { google: "Google Calendar", calendly: "Calendly" };
const BLURB: Record<CalendarProviderKey, string> = {
  google: "The AI reads your free/busy times and creates events on your Google calendar.",
  calendly: "The AI offers the open times of one Calendly event type and books them. On the Calendly Free plan it sends a single-use scheduling link instead.",
};

/** Calendar providers (Google, Calendly). Also the landing page of the OAuth redirects (`?calendar=connected|error&provider=`). */
export default function CalendarSettings() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const flag = sp.get("calendar");
  const flagProvider = (sp.get("provider") === "calendly" ? "calendly" : "google") as CalendarProviderKey;
  const q = useQuery({ queryKey: ["calendars"], queryFn: ops.calendars, enabled: isAdmin });
  const dismiss = () => { const n = new URLSearchParams(sp); n.delete("calendar"); n.delete("reason"); n.delete("provider"); setSp(n, { replace: true }); };
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["calendars"] }); void qc.invalidateQueries({ queryKey: ["calendar"] }); };
  const setDefault = useMutation({ mutationFn: ops.setDefaultCalendar, onSuccess: () => { toast.success("The AI now uses this calendar"); refresh(); }, onError: (e) => toast.error("Could not change the calendar", { description: errMsg(e) }) });
  const connected = q.data?.items.filter((i) => i.connected) ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title="Calendar" subtitle="Connect the calendar the AI books appointments on." />
      {flag === "connected" && <p role="status" className="flex items-center gap-2 rounded-lg bg-success/12 px-3 py-2 text-sm text-success"><CheckCircle2 className="size-4" />{LABEL[flagProvider]} connected.<button className="ml-auto" aria-label="Dismiss" onClick={dismiss}><X className="size-4" /></button></p>}
      {flag === "error" && <p role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/12 px-3 py-2 text-sm text-destructive"><TriangleAlert className="size-4 shrink-0" />Could not connect {LABEL[flagProvider]}{sp.get("reason") ? ` (${sp.get("reason")})` : ""}. Try again.<button className="ml-auto" aria-label="Dismiss" onClick={dismiss}><X className="size-4" /></button></p>}
      {!isAdmin ? <p className="text-sm text-muted-foreground">Only admins can manage calendar connections.</p>
        : q.isPending ? <Skeleton className="h-40" />
        : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : (
          <>
            {connected.length > 1 && (
              <Card className="gap-2">
                <h2 className="font-display text-base font-semibold">Calendar used by the AI</h2>
                <p className="text-sm text-muted-foreground">Both calendars are connected. Choose where the AI checks availability and books.</p>
                <div role="radiogroup" aria-label="Calendar used by the AI" className="flex flex-wrap gap-2">
                  {connected.map((c) => (
                    <Button key={c.provider} role="radio" aria-checked={q.data.default === c.provider} variant={q.data.default === c.provider ? "default" : "outline"} disabled={setDefault.isPending}
                      onClick={() => q.data.default !== c.provider && setDefault.mutate(c.provider)}>{LABEL[c.provider]}</Button>))}
                </div>
              </Card>)}
            <div className="grid gap-5 lg:grid-cols-2">
              {q.data.items.map((s) => <ProviderCard key={s.provider} s={s} isDefault={q.data.default === s.provider && connected.length > 1} onChange={refresh} />)}
            </div>
          </>)}
    </div>
  );
}

function ProviderCard({ s, isDefault, onChange }: { s: CalendarProviderState; isDefault: boolean; onChange: () => void }) {
  const p = s.provider;
  const [confirm, setConfirm] = useState(false);
  const [calId, setCalId] = useState<string | null>(null);
  const ok = s.connected && s.status !== "error";
  const bad = s.connected && s.status === "error";
  const connect = useMutation({
    mutationFn: p === "google" ? ops.connectCalendar : ops.connectCalendly,
    onSuccess: (r) => { window.location.assign(r.url); },
    onError: (e) => { if (!(e instanceof ApiError && e.status === 503)) toast.error(`Could not connect ${LABEL[p]}`, { description: errMsg(e) }); },
  });
  const disconnect = useMutation({
    mutationFn: p === "google" ? ops.disconnectCalendar : ops.disconnectCalendly,
    onSuccess: () => { setConfirm(false); toast.success(`${LABEL[p]} disconnected`); onChange(); },
    onError: (e) => toast.error("Could not disconnect", { description: errMsg(e) }),
  });
  const saveGoogleId = useMutation({ mutationFn: (id: string) => ops.patchCalendar(id), onSuccess: () => { setCalId(null); toast.success("Calendar saved"); onChange(); }, onError: (e) => toast.error("Could not save calendar", { description: errMsg(e) }) });
  const unconfigured = !s.configured || (connect.error instanceof ApiError && connect.error.status === 503);

  return (
    <Card className={cn("gap-4", ok && "border-success/35", bad && "border-destructive/40")} aria-label={LABEL[p]}>
      <div className="flex items-start gap-3">
        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", ok ? "bg-success/12 text-success" : bad ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground")}>
          {ok ? <CalendarCheck className="size-5" /> : bad ? <TriangleAlert className="size-5" /> : <CalendarX2 className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg font-semibold">{LABEL[p]}</h2>
            {ok ? <Badge variant="success"><span className="size-1.5 rounded-full bg-success" aria-hidden="true" />Connected</Badge> : bad ? <Badge variant="destructive">Needs attention</Badge> : <Badge variant="secondary">Not connected</Badge>}
            {isDefault && <Badge variant="secondary">Used by the AI</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{BLURB[p]}</p>
        </div>
      </div>
      {bad && <p role="alert" className="rounded-lg bg-destructive/12 px-3 py-2 text-sm text-destructive">{s.lastError ?? "The connection stopped working."} Reconnect to fix it.</p>}
      {s.connected && (
        <dl className="grid gap-3 rounded-xl bg-muted/60 p-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Account</dt><dd className="truncate font-medium">{s.accountEmail ?? "unknown"}</dd></div>
          {s.connectedAt && <div><dt className="text-muted-foreground">Connected since</dt><dd className="font-medium">{fmtDate(s.connectedAt)}</dd></div>}
        </dl>)}
      {s.connected && p === "calendly" && <EventTypePicker selected={s.eventTypeSelected ?? false} onSaved={onChange} />}
      {s.connected && p === "google" && (
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (calId?.trim()) saveGoogleId.mutate(calId.trim()); }}>
          <div className="min-w-0 flex-1"><TextField label="Calendar ID" value={calId ?? s.calendarId ?? "primary"} onChange={(e) => setCalId(e.target.value)} /></div>
          <Button variant="outline" disabled={calId === null || saveGoogleId.isPending}>Save</Button>
        </form>)}
      <div className="flex flex-wrap items-center gap-2">
        {s.connected ? (
          <>
            <Button variant={bad ? "default" : "outline"} disabled={connect.isPending || unconfigured} onClick={() => connect.mutate()}><RefreshCw />{connect.isPending ? "Opening…" : "Reconnect"}</Button>
            <Button variant="ghost" className="text-destructive hover:bg-destructive/10 sm:ml-auto" onClick={() => setConfirm(true)}><Link2Off />Disconnect<span className="sr-only"> {LABEL[p]}</span></Button>
          </>
        ) : <Button disabled={connect.isPending || unconfigured} onClick={() => connect.mutate()}>{connect.isPending ? "Opening…" : `Connect ${LABEL[p]}`}</Button>}
      </div>
      {unconfigured && <p role="alert" className="text-sm text-destructive">{LABEL[p]} is not configured on this server. Set {p === "google" ? "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET" : "CALENDLY_CLIENT_ID, CALENDLY_CLIENT_SECRET"} and ENCRYPTION_KEY, then reload.</p>}
      {confirm && <ConfirmModal title={`Disconnect ${LABEL[p]}`} danger confirm="Disconnect" busy={disconnect.isPending} body="Stored tokens are deleted and the AI can no longer book on it. Existing bookings are kept." onConfirm={() => disconnect.mutate()} onClose={() => setConfirm(false)} />}
    </Card>
  );
}

function EventTypePicker({ selected, onSaved }: { selected: boolean; onSaved: () => void }) {
  const q = useQuery({ queryKey: ["calendly-event-types"], queryFn: ops.calendlyEventTypes });
  const save = useMutation({ mutationFn: ops.setCalendlyEventType, onSuccess: () => { toast.success("Event type saved"); void q.refetch(); onSaved(); }, onError: (e) => toast.error("Could not save the event type", { description: errMsg(e) }) });
  if (q.isPending) return <Skeleton className="h-12" />;
  if (q.isError) return <p role="alert" className="text-sm text-destructive">Could not load your Calendly event types ({errMsg(q.error)}). Try reconnecting.</p>;
  const cur = q.data.find((e) => e.selected)?.uri ?? "";
  return (
    <div className="space-y-1">
      <Select label="Event type the AI books" value={cur} disabled={save.isPending} onChange={(e) => e.target.value && save.mutate(e.target.value)}
        hint={selected ? "Meeting length and open times come from this Calendly event type." : "Choose one so the AI can book."}>
        {!cur && <option value="">Select an event type</option>}
        {q.data.map((e) => <option key={e.uri} value={e.uri}>{e.name} ({e.durationMinutes} min)</option>)}
      </Select>
    </div>
  );
}
