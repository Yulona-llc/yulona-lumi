import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { CalendarCheck, CalendarX2, CheckCircle2, Link2Off, TriangleAlert, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ApiError } from "../../api/client";
import { errMsg } from "../common/api";
import { ConfirmModal, ErrorState, fmtDate, TextField, useRole } from "../common/ui";
import { ops } from "../ops-settings/opsApi";

/** Google Calendar connection (admin+ to change). Also reads the `?calendar=connected|error` redirect from the OAuth callback. */
export default function CalendarCard() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const flag = sp.get("calendar");
  const q = useQuery({ queryKey: ["calendar"], queryFn: ops.calendar });
  const [calId, setCalId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const done = () => void qc.invalidateQueries({ queryKey: ["calendar"] });
  const connect = useMutation({ mutationFn: ops.connectCalendar, onSuccess: (r) => { window.location.assign(r.url); }, onError: (e) => { if (!(e instanceof ApiError && e.status === 503)) toast.error("Could not connect Google Calendar", { description: errMsg(e) }); } });
  const save = useMutation({ mutationFn: (id: string) => ops.patchCalendar(id), onSuccess: () => { setCalId(null); toast.success("Calendar saved"); done(); }, onError: (e) => toast.error("Could not save calendar", { description: errMsg(e) }) });
  const disconnect = useMutation({ mutationFn: ops.disconnectCalendar, onSuccess: () => { setConfirm(false); toast.success("Google Calendar disconnected"); done(); }, onError: (e) => toast.error("Could not disconnect", { description: errMsg(e) }) });
  const dismiss = () => { const n = new URLSearchParams(sp); n.delete("calendar"); n.delete("reason"); setSp(n, { replace: true }); };
  const unconfigured = connect.error instanceof ApiError && connect.error.status === 503;
  const c = q.data;
  const ok = c?.connected && c.status !== "error";
  const bad = c?.connected && c.status === "error";

  return (
    <Card className={cn("gap-4", ok && "border-success/35", bad && "border-destructive/40")}>
      <div className="flex items-start gap-3">
        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", ok ? "bg-success/12 text-success" : bad ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground")}>
          {ok ? <CalendarCheck className="size-5" /> : bad ? <TriangleAlert className="size-5" /> : <CalendarX2 className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-lg font-semibold">Google Calendar</h2>
            {c && (ok ? <Badge variant="success"><span className="size-1.5 rounded-full bg-success" aria-hidden="true" />Connected</Badge> : bad ? <Badge variant="destructive">Needs attention</Badge> : <Badge variant="secondary">Not connected</Badge>)}</div>
          <p className="text-sm text-muted-foreground">Lets the AI check availability and book appointments on your calendar.</p>
        </div>
      </div>
      {flag === "connected" && <p role="status" className="flex items-center gap-2 rounded-lg bg-success/12 px-3 py-2 text-sm text-success"><CheckCircle2 className="size-4" />Google Calendar connected.<button className="ml-auto" aria-label="Dismiss" onClick={dismiss}><X className="size-4" /></button></p>}
      {flag === "error" && <p role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/12 px-3 py-2 text-sm text-destructive"><TriangleAlert className="size-4 shrink-0" />Could not connect Google Calendar{sp.get("reason") ? ` (${sp.get("reason")})` : ""}. Try again.<button className="ml-auto" aria-label="Dismiss" onClick={dismiss}><X className="size-4" /></button></p>}
      {q.isPending ? <Skeleton className="h-16" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : c?.connected ? (
        <div className="space-y-3">
          <dl className="grid gap-3 rounded-xl bg-muted/60 p-3 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Account</dt><dd className="truncate font-medium">{c.accountEmail ?? "unknown"}</dd></div>
            <div><dt className="text-muted-foreground">Calendar</dt><dd className="truncate font-medium">{c.calendarId ?? "primary"}</dd></div>
            {c.connectedAt && <div><dt className="text-muted-foreground">Connected since</dt><dd className="font-medium">{fmtDate(c.connectedAt)}</dd></div>}
          </dl>
          {isAdmin && (
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (calId?.trim()) save.mutate(calId.trim()); }}>
              <div className="sm:w-72"><TextField label="Calendar ID" value={calId ?? c.calendarId ?? "primary"} onChange={(e) => setCalId(e.target.value)} /></div>
              <Button variant="outline" disabled={calId === null || save.isPending}>Save</Button>
              <Button type="button" variant="ghost" className="text-destructive hover:bg-destructive/10 sm:ml-auto" onClick={() => setConfirm(true)}><Link2Off />Disconnect</Button>
            </form>)}
        </div>
      ) : isAdmin ? (
        <div className="space-y-2">
          <Button disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? "Opening Google…" : "Connect Google Calendar"}</Button>
          {unconfigured && <p role="alert" className="text-sm text-destructive">Google Calendar is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ENCRYPTION_KEY, then try again.</p>}
        </div>
      ) : <p className="text-sm text-muted-foreground">No calendar connected. Ask an admin to connect Google Calendar.</p>}
      {confirm && <ConfirmModal title="Disconnect Google Calendar" danger confirm="Disconnect" busy={disconnect.isPending} body="Stored tokens are deleted and the AI can no longer book. Existing bookings are kept." onConfirm={() => disconnect.mutate()} onClose={() => setConfirm(false)} />}
    </Card>
  );
}
