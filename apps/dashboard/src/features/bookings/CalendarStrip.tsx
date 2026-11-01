import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { CalendarCheck, CalendarX2, TriangleAlert } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { useRole } from "../common/ui";
import { ops, type CalendarProviderKey, type CalendarProviderState } from "../ops-settings/opsApi";

export const PROVIDER_LABEL: Record<CalendarProviderKey, string> = { google: "Google Calendar", calendly: "Calendly" };
const SHORT: Record<CalendarProviderKey, string> = { google: "Google", calendly: "Calendly" };

/** Calendar connections for the Bookings page. Only admins can read them; for other roles `known` is false and the server decides on submit. */
export function useCalendars() {
  const { isAdmin } = useRole();
  const q = useQuery({ queryKey: ["calendars"], queryFn: ops.calendars, enabled: isAdmin });
  const items = q.data?.items ?? [];
  const connected = items.filter((i) => i.connected);
  return { q, items, connected, defaultProvider: q.data?.default ?? connected[0]?.provider ?? null, known: isAdmin && q.isSuccess, isAdmin };
}

/** One row per provider: state, and an inline Connect button when the provider is available on this server. */
export default function CalendarStrip({ calendars }: { calendars: ReturnType<typeof useCalendars> }) {
  const { q, items, connected, isAdmin } = calendars;
  if (!isAdmin) return null;
  if (q.isPending) return <Skeleton className="h-16" />;
  if (q.isError) return <p role="alert" className="text-sm text-destructive">Could not load calendar connections ({errMsg(q.error)}).</p>;
  return (
    <Card className="gap-3 p-4" aria-label="Calendars">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold">Calendars</h2>
        <Link className="text-sm text-accent-foreground hover:underline" to="/settings/integrations">Manage in Connectors</Link>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">{items.map((s) => <li key={s.provider}><ProviderRow s={s} /></li>)}</ul>
      {connected.length === 0 && <p className="text-sm text-muted-foreground">Connect a calendar to create bookings. The AI also needs one to book appointments.</p>}
    </Card>
  );
}

function ProviderRow({ s }: { s: CalendarProviderState }) {
  const p = s.provider;
  const ok = s.connected && s.status !== "error";
  const bad = s.connected && s.status === "error";
  const connect = useMutation({
    mutationFn: p === "google" ? ops.connectCalendar : ops.connectCalendly,
    onSuccess: (r) => { window.location.assign(r.url); },
    onError: (e) => toast.error(`Could not connect ${PROVIDER_LABEL[p]}`, { description: errMsg(e) }),
  });
  const blocked = p === "calendly" && !!s.redirectError;
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border p-3", ok && "border-success/35", bad && "border-destructive/40")}>
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", ok ? "bg-success/12 text-success" : bad ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground")}>
        {ok ? <CalendarCheck className="size-4" /> : bad ? <TriangleAlert className="size-4" /> : <CalendarX2 className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{PROVIDER_LABEL[p]}</p>
        <p className="truncate text-xs text-muted-foreground">{s.connected ? (s.accountEmail ?? "Connected") : s.configured ? "Not connected" : "Not set up on this server"}</p>
      </div>
      {ok ? <Badge variant="success">Connected</Badge> : bad ? <Badge variant="destructive">Needs attention</Badge> : null}
      {!ok && s.configured && <Button size="sm" variant={bad ? "default" : "outline"} disabled={connect.isPending || blocked} onClick={() => connect.mutate()}>{connect.isPending ? "Opening…" : bad ? `Reconnect ${SHORT[p]}` : `Connect ${SHORT[p]}`}</Button>}
      {!s.connected && !s.configured && <Badge variant="secondary">Unavailable</Badge>}
    </div>
  );
}
