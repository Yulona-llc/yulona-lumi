import { useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { label, ops, relTime, type Notif } from "./opsApi";

function target(n: Notif): string | null {
  const d = n.data ?? {};
  if (n.type.startsWith("handoff")) return "/attention";
  if (n.type.startsWith("ticket") && d.ticketId) return "/tickets";
  if (n.type.startsWith("booking")) return "/bookings";
  if (d.conversationId) return `/inbox/${d.conversationId}`;
  return null;
}

/** Self-contained bell with unread badge + popover. Mount anywhere inside the authenticated shell. */
export default function NotificationsBell({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => ops.notifications(), refetchInterval: 30_000, retry: false });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["notifications"] });
  const read = useMutation({ mutationFn: (n: Notif) => ops.markRead(n.id), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: ops.readAll, onSuccess: refresh });
  const unread = q.data?.unreadCount ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("relative", className)} aria-haspopup="true" aria-expanded={open}>
          <Bell />
          <span className="sr-only">Notifications{unread ? `, ${unread} unread` : ""}</span>
          {unread > 0 && <span aria-hidden="true" className="absolute right-1 top-1 grid min-h-4.5 min-w-4.5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground ring-2 ring-background">{unread > 99 ? "99+" : unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" aria-label="Notifications">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-display font-semibold">Notifications</p>
          <Button variant="ghost" size="sm" disabled={unread === 0 || readAll.isPending} onClick={() => readAll.mutate()}><CheckCheck />Mark all read</Button>
        </div>
        {q.isPending ? <div className="space-y-2 p-3"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
          : q.isError ? <p role="alert" className="p-4 text-sm text-destructive">Could not load notifications.</p>
          : q.data.items.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">You are all caught up.</p> : (
            <ul className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1.5">{q.data.items.map((n) => (
              <li key={n.id}>
                <button className={cn("flex w-full gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted", !n.readAt && "bg-accent/60")}
                  onClick={() => { if (!n.readAt) read.mutate(n); const t = target(n); if (t) nav(t); setOpen(false); }}>
                  <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-primary")} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{n.title || label(n.type)}</span>
                    {n.body && <span className="block truncate text-xs text-muted-foreground">{n.body}</span>}
                    <span className="block text-xs text-muted-foreground">{relTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>))}</ul>)}
      </PopoverContent>
    </Popover>
  );
}
