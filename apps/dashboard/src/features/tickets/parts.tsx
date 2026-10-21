import { Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { label, relTime, type Ticket, type TicketPriority, type TicketStatus } from "../ops-settings/opsApi";

const PRI: Record<TicketPriority, { variant: "secondary" | "info" | "warning" | "destructive"; dot: string }> = {
  low: { variant: "secondary", dot: "bg-muted-foreground/50" },
  normal: { variant: "info", dot: "bg-info" },
  high: { variant: "warning", dot: "bg-warning" },
  urgent: { variant: "destructive", dot: "bg-destructive" },
};
export const PriorityBadge = ({ p }: { p: TicketPriority }) => <Badge variant={PRI[p].variant}><span aria-hidden="true" className={cn("size-1.5 rounded-full", PRI[p].dot)} />{label(p)}</Badge>;

export const STATUS_TONE: Record<TicketStatus, string> = {
  open: "bg-info", in_progress: "bg-primary", waiting: "bg-warning", resolved: "bg-success", closed: "bg-muted-foreground/50",
};
export const StatusDot = ({ s, className }: { s: TicketStatus; className?: string }) => <span aria-hidden="true" className={cn("inline-block size-2 rounded-full", STATUS_TONE[s], className)} />;

/** SLA state: breached (red), due soon < 1h (amber), on track (green), or none once resolved. */
export function slaState(t: Pick<Ticket, "dueAt" | "slaBreachedAt" | "status">, now = Date.now()): "breached" | "soon" | "ok" | "none" {
  if (t.status === "resolved" || t.status === "closed") return t.slaBreachedAt ? "breached" : "none";
  if (t.slaBreachedAt || (t.dueAt && new Date(t.dueAt).getTime() < now)) return "breached";
  if (!t.dueAt) return "none";
  return new Date(t.dueAt).getTime() - now < 3600_000 ? "soon" : "ok";
}
export function SlaBadge({ t }: { t: Ticket }) {
  const s = slaState(t);
  if (s === "none") return null;
  const variant = s === "breached" ? "destructive" : s === "soon" ? "warning" : "success";
  const text = s === "breached" ? "SLA breached" : `SLA ${relTime(t.dueAt)}`;
  return <Badge variant={variant}><Timer aria-hidden="true" />{text}</Badge>;
}
