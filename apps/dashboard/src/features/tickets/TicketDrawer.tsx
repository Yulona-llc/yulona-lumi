import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowRightLeft, CircleDot, Flag, MessageSquare, Send, Timer, Trash2, UserRound, ExternalLink, type LucideIcon } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ag, errMsg } from "../common/api";
import { ConfirmModal, ErrorState, fmtDate, Loading, Modal, Select, TextArea, TextField, useRole } from "../common/ui";
import { label, ops, relTime, TICKET_PRIORITIES, TICKET_STATUSES, type Ticket, type TicketEvent, type TicketPriority, type TicketStatus } from "../ops-settings/opsApi";
import { PriorityBadge, SlaBadge, StatusDot } from "./parts";

function describe(e: TicketEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "created": return "created the ticket";
    case "status_changed": return `changed status ${d.from ? `from ${label(String(d.from))} ` : ""}to ${label(String(d.to ?? ""))}`;
    case "priority_changed": return `changed priority ${d.from ? `from ${label(String(d.from))} ` : ""}to ${label(String(d.to ?? ""))}`;
    case "assigned": return "changed the assignee";
    case "sla_breached": return "SLA breached";
    case "comment": return "commented";
    default: return label(e.type);
  }
}
const ICON: Record<string, LucideIcon> = { created: CircleDot, status_changed: ArrowRightLeft, priority_changed: Flag, assigned: UserRound, sla_breached: Timer, comment: MessageSquare };

export function TicketDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { atLeast, isAdmin } = useRole();
  const canWrite = atLeast("agent");
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ["ticket", id], queryFn: () => ops.ticket(id) });
  const ev = useQuery({ queryKey: ["ticket-events", id], queryFn: () => ops.ticketEvents(id) });
  const users = useQuery({ queryKey: ["users"], queryFn: ag.users, enabled: canWrite });
  const [text, setText] = useState("");
  const [del, setDel] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["ticket", id] }); void qc.invalidateQueries({ queryKey: ["ticket-events", id] }); void qc.invalidateQueries({ queryKey: ["tickets"] }); void qc.invalidateQueries({ queryKey: ["board"] }); };
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => ops.patchTicket(id, b),
    onSuccess: (_r, b) => { toast.success(b.status ? `Moved to ${label(String(b.status))}` : b.priority ? `Priority set to ${label(String(b.priority))}` : "Assignee updated"); refresh(); },
    onError: (e) => toast.error("Could not update ticket", { description: errMsg(e) }),
  });
  const comment = useMutation({ mutationFn: () => ops.comment(id, text.trim()), onSuccess: () => { setText(""); toast.success("Comment added"); refresh(); }, onError: (e) => toast.error("Could not add comment", { description: errMsg(e) }) });
  const remove = useMutation({ mutationFn: () => ops.deleteTicket(id), onSuccess: () => { toast.success("Ticket deleted"); refresh(); onClose(); }, onError: (e) => toast.error("Could not delete ticket", { description: errMsg(e) }) });
  const tk = t.data as Ticket | undefined;

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full max-w-none gap-0 sm:max-w-xl">
        <SheetHeader className="border-b pb-3">
          <SheetTitle className="pr-2 leading-snug">{tk ? <><span className="mr-1.5 font-mono text-sm font-normal text-muted-foreground">#{tk.number}</span>{tk.title}</> : "Ticket"}</SheetTitle>
          <SheetDescription className="sr-only">Ticket details and activity</SheetDescription>
          {tk && <div className="mt-1 flex flex-wrap items-center gap-1.5"><Badge variant="outline"><StatusDot s={tk.status} />{label(tk.status)}</Badge><PriorityBadge p={tk.priority} /><SlaBadge t={tk} />{(tk.tags ?? []).map((g) => <Badge key={g.id} variant="secondary"><span aria-hidden="true" className="size-2 rounded-full" style={{ background: g.color }} />{g.name}</Badge>)}</div>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {t.isPending ? <Loading /> : t.isError ? <ErrorState error={t.error} retry={() => void t.refetch()} /> : tk && (
            <div className="space-y-6 pt-4">
              {tk.description && <p className="whitespace-pre-wrap text-[0.9375rem]">{tk.description}</p>}
              {(tk.contactName || tk.conversationId) && (
                <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                  {tk.contactName && <span>Contact: <b className="font-medium text-foreground">{tk.contactName}</b></span>}
                  {tk.conversationId && <Link className="inline-flex items-center gap-1 font-medium text-accent-foreground underline-offset-4 hover:underline" to={`/inbox/${tk.conversationId}`}><ExternalLink className="size-3.5" />Open conversation</Link>}
                </p>)}
              <div className="grid gap-3 sm:grid-cols-3">
                <Select label="Status" value={tk.status} disabled={!canWrite || patch.isPending} onChange={(e) => patch.mutate({ status: e.target.value as TicketStatus })}>{TICKET_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
                <Select label="Priority" value={tk.priority} disabled={!canWrite || patch.isPending} onChange={(e) => patch.mutate({ priority: e.target.value as TicketPriority })}>{TICKET_PRIORITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
                <Select label="Assignee" value={tk.assigneeUserId ?? ""} disabled={!canWrite || patch.isPending} onChange={(e) => patch.mutate({ assigneeUserId: e.target.value || null })}>
                  <option value="">Unassigned</option>{(users.data ?? []).filter((u) => u.status === "active").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              </div>
              <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted/60 p-3 text-sm">
                <div><dt className="text-muted-foreground">SLA due</dt><dd className="font-medium">{fmtDate(tk.dueAt)}</dd></div>
                <div><dt className="text-muted-foreground">Created</dt><dd className="font-medium">{fmtDate(tk.createdAt)}</dd></div>
              </dl>
              <section aria-labelledby="tl">
                <h3 id="tl" className="mb-3 font-display text-base font-semibold">Timeline</h3>
                {ev.isPending ? <Loading rows={2} /> : ev.isError ? <ErrorState error={ev.error} retry={() => void ev.refetch()} /> : ev.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : (
                  <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[0.9rem] before:top-2 before:w-px before:bg-border" aria-label="Ticket timeline">
                    {ev.data.items.map((e) => {
                      const Icon = ICON[e.type] ?? CircleDot;
                      return (
                        <li key={e.id} className="relative flex gap-3 text-sm">
                          <span aria-hidden="true" className={`relative z-10 grid size-7 shrink-0 place-items-center rounded-full border bg-card ${e.type === "sla_breached" ? "text-destructive" : "text-muted-foreground"}`}><Icon className="size-3.5" /></span>
                          <div className="min-w-0 flex-1 pt-0.5">
                            <p><b className="font-medium">{e.actorName ?? "System"}</b> {describe(e)} <span className="whitespace-nowrap text-xs text-muted-foreground" title={fmtDate(e.createdAt)}>{relTime(e.createdAt)}</span></p>
                            {e.type === "comment" && <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/70 p-2.5">{String((e.data as { text?: string } | null)?.text ?? "")}</p>}
                          </div>
                        </li>);
                    })}
                  </ol>)}
              </section>
              {isAdmin && <Button variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => setDel(true)}><Trash2 />Delete ticket</Button>}
            </div>)}
        </div>
        {canWrite && tk && (
          <form className="flex items-end gap-2 border-t bg-card p-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) comment.mutate(); }}>
            <div className="min-w-0 flex-1"><TextArea label="Add a comment" rows={2} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} /></div>
            <Button disabled={!text.trim() || comment.isPending}><Send />Comment</Button>
          </form>)}
        {del && <ConfirmModal title="Delete ticket" danger confirm="Delete" busy={remove.isPending} body="This removes the ticket and its history permanently." onConfirm={() => remove.mutate()} onClose={() => setDel(false)} />}
      </SheetContent>
    </Sheet>
  );
}

export function NewTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Ticket) => void }) {
  const users = useQuery({ queryKey: ["users"], queryFn: ag.users });
  const [f, setF] = useState({ title: "", description: "", priority: "normal" as TicketPriority, assigneeUserId: "" });
  const m = useMutation({
    mutationFn: () => ops.createTicket({ title: f.title.trim(), priority: f.priority, ...(f.description.trim() ? { description: f.description.trim() } : {}), ...(f.assigneeUserId ? { assigneeUserId: f.assigneeUserId } : {}) }),
    onSuccess: (t) => { toast.success("Ticket created", { description: `#${t.number} ${t.title}` }); onCreated(t); },
    onError: (e) => toast.error("Could not create ticket", { description: errMsg(e) }),
  });
  return (
    <Modal title="New ticket" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (f.title.trim()) m.mutate(); }}>
        <TextField label="Title" required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <TextArea label="Description" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TicketPriority })}>{TICKET_PRIORITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
          <Select label="Assignee" value={f.assigneeUserId} onChange={(e) => setF({ ...f, assigneeUserId: e.target.value })}><option value="">Unassigned</option>{(users.data ?? []).filter((u) => u.status === "active").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        </div>
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!f.title.trim() || m.isPending}>Create ticket</Button></div>
      </form>
    </Modal>
  );
}
