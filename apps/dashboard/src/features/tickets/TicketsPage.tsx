import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowRightLeft, GripVertical, Plus, Search, Trash2, UserRound, X, Flag } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ag, errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, Loading, PageHeader, Select, useRole } from "../common/ui";
import { FilterPanel } from "../ops-settings/FilterPanel";
import { initials, useIsDesktop } from "../ops-settings/hooks";
import { Segmented } from "../ops-settings/Segmented";
import { label, ops, relTime, TICKET_PRIORITIES, TICKET_STATUSES, type Board, type Ticket, type TicketFilters, type TicketStatus } from "../ops-settings/opsApi";
import { NewTicketModal, TicketDrawer } from "./TicketDrawer";
import { PriorityBadge, SlaBadge, StatusDot } from "./parts";

type View = "board" | "table";
const lastView = (): View => { try { return localStorage.getItem("yl_tickets_view") === "table" ? "table" : "board"; } catch { return "board"; } };

export default function TicketsPage() {
  const { atLeast, isAdmin } = useRole();
  const canWrite = atLeast("agent");
  const desktop = useIsDesktop();
  const qc = useQueryClient();
  const [view, setView] = useState<View>(lastView);
  const [f, setF] = useState<TicketFilters>({});
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState(false);
  const [phoneStatus, setPhoneStatus] = useState<TicketStatus>("open");
  const users = useQuery({ queryKey: ["users"], queryFn: ag.users, enabled: canWrite });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["tickets"] }); void qc.invalidateQueries({ queryKey: ["board"] }); };

  const board = useQuery({ queryKey: ["board", f], queryFn: () => ops.board(f), enabled: view === "board", refetchInterval: 30_000 });
  const list = useInfiniteQuery({ queryKey: ["tickets", f], queryFn: ({ pageParam }) => ops.tickets(f, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined, enabled: view === "table" });
  const move = useMutation({
    mutationFn: (v: { id: string; status: TicketStatus }) => ops.patchTicket(v.id, { status: v.status }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["board"] });
      qc.setQueriesData<Board>({ queryKey: ["board"] }, (b) => {
        if (!b?.columns) return b;
        const card = TICKET_STATUSES.flatMap((s) => b.columns[s] ?? []).find((x) => x.id === v.id);
        if (!card || card.status === v.status) return b;
        const columns = { ...b.columns }, totals = { ...b.totals };
        columns[card.status] = (columns[card.status] ?? []).filter((x) => x.id !== v.id); totals[card.status] = Math.max(0, (totals[card.status] ?? 1) - 1);
        columns[v.status] = [{ ...card, status: v.status }, ...(columns[v.status] ?? [])]; totals[v.status] = (totals[v.status] ?? 0) + 1;
        return { columns, totals };
      });
    },
    onSuccess: (_r, v) => { toast.success(`Moved to ${label(v.status)}`); refresh(); },
    onError: (e) => { toast.error("Could not move ticket", { description: errMsg(e) }); refresh(); },
  });
  const bulk = useMutation({
    mutationFn: (b: Parameters<typeof ops.bulk>[0]) => ops.bulk(b),
    onSuccess: (r, b) => { toast.success(b.action === "delete" ? `Deleted ${r.updated} ticket${r.updated === 1 ? "" : "s"}` : `Updated ${r.updated} ticket${r.updated === 1 ? "" : "s"}`, r.skipped ? { description: `${r.skipped} skipped` } : undefined); setSel(new Set()); setConfirmDel(false); refresh(); },
    onError: (e) => toast.error("Could not update tickets", { description: errMsg(e) }),
  });

  const setViewP = (v: View) => { setView(v); setSel(new Set()); try { localStorage.setItem("yl_tickets_view", v); } catch { /* ignore */ } };
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel];
  const activeFilters = [f.priority, f.assignee, view === "table" ? f.status : undefined, f.slaBreached].filter(Boolean).length;
  const activeUsers = (users.data ?? []).filter((u) => u.status === "active");

  return (
    <div>
      <PageHeader title="Tickets" subtitle="Track customer issues with SLA timers and a full audit trail."
        actions={<>
          <Segmented label="View" value={view} onChange={setViewP} options={[{ value: "board", label: desktop ? "Board" : "List", name: desktop ? "Board" : "List" }, { value: "table", label: "Table", name: "Table" }]} />
          {canWrite && <Button onClick={() => setCreating(true)}><Plus />New ticket</Button>}
        </>} />
      <form role="search" aria-label="Filter tickets" className="mb-5 flex gap-2" onSubmit={(e) => e.preventDefault()}>
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Label htmlFor="tq" className="sr-only">Search</Label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="tq" type="search" className="pl-9" placeholder="Search title, description or #number" value={f.q ?? ""} onChange={(e) => setF({ ...f, q: e.target.value || undefined })} />
        </div>
        <FilterPanel active={activeFilters} onClear={() => setF({ q: f.q })}>
          <Select label="Priority" value={f.priority ?? ""} onChange={(e) => setF({ ...f, priority: e.target.value || undefined })}><option value="">Any</option>{TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}</Select>
          <Select label="Assignee" value={f.assignee ?? ""} onChange={(e) => setF({ ...f, assignee: e.target.value || undefined })}><option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          {view === "table" && <Select label="Status" value={f.status ?? ""} onChange={(e) => setF({ ...f, status: e.target.value || undefined })}><option value="">Any</option>{TICKET_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>}
          <div className="flex min-h-11 items-center gap-3"><Switch id="sla" checked={!!f.slaBreached} onCheckedChange={(v) => setF({ ...f, slaBreached: v || undefined })} /><Label htmlFor="sla" className="cursor-pointer">SLA breached only</Label></div>
        </FilterPanel>
      </form>

      {view === "board" ? (
        board.isPending ? <BoardSkeleton /> : board.isError ? <ErrorState error={board.error} retry={() => void board.refetch()} /> : desktop ? (
          <Kanban board={board.data} canWrite={canWrite} onOpen={setOpen} onMove={(id, status) => move.mutate({ id, status })} />
        ) : (
          <PhoneList board={board.data} status={phoneStatus} setStatus={setPhoneStatus} canWrite={canWrite} onOpen={setOpen} onMove={(id, status) => move.mutate({ id, status })} onNew={() => setCreating(true)} />
        )
      ) : list.isPending ? <Loading label="Loading tickets" /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : rows.length === 0 ? (
        <Empty title="No tickets found" body="Adjust the filters or create a ticket to get started." action={canWrite && <Button onClick={() => setCreating(true)}><Plus />New ticket</Button>} />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <caption className="sr-only">Tickets</caption>
              <TableHeader><TableRow className="hover:bg-transparent">
                {canWrite && <TableHead scope="col" className="w-10"><Checkbox aria-label="Select all tickets" checked={sel.size === rows.length ? true : sel.size > 0 ? "indeterminate" : false} onCheckedChange={(v) => setSel(v === true ? new Set(rows.map((r) => r.id)) : new Set())} /></TableHead>}
                <TableHead scope="col">Ticket</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col">Priority</TableHead><TableHead scope="col">SLA</TableHead><TableHead scope="col">Assignee</TableHead><TableHead scope="col">Updated</TableHead></TableRow></TableHeader>
              <TableBody>{rows.map((t: Ticket) => (
                <TableRow key={t.id} data-state={sel.has(t.id) ? "selected" : undefined}>
                  {canWrite && <TableCell><Checkbox aria-label={`Select ticket ${t.number}`} checked={sel.has(t.id)} onCheckedChange={() => toggle(t.id)} /></TableCell>}
                  <TableCell className="max-w-72"><button className="block max-w-full truncate text-left font-medium hover:underline" onClick={() => setOpen(t.id)}><span className="mr-1.5 font-mono text-xs font-normal text-muted-foreground">#{t.number}</span>{t.title}</button></TableCell>
                  <TableCell><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><StatusDot s={t.status} />{label(t.status)}</span></TableCell>
                  <TableCell><PriorityBadge p={t.priority} /></TableCell><TableCell><SlaBadge t={t} /></TableCell>
                  <TableCell className="whitespace-nowrap">{t.assigneeName ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{relTime(t.updatedAt)}</TableCell>
                </TableRow>))}</TableBody>
            </Table>
          </div>
          {list.hasNextPage && <div className="mt-4 text-center"><Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>}
        </>)}

      <AnimatePresence>
        {canWrite && view === "table" && sel.size > 0 && (
          <motion.div key="bulk" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="fixed inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border bg-sidebar p-2.5 text-sidebar-foreground shadow-2xl md:bottom-6">
            <span role="status" className="px-2 text-sm font-semibold">{sel.size} selected</span>
            <BulkMenu icon={<ArrowRightLeft />} name="Set status for selected" text="Status" items={TICKET_STATUSES.map((s) => ({ value: s, label: label(s) }))} onPick={(v) => bulk.mutate({ ids, action: "set_status", value: v })} />
            <BulkMenu icon={<Flag />} name="Set priority for selected" text="Priority" items={TICKET_PRIORITIES.map((s) => ({ value: s, label: label(s) }))} onPick={(v) => bulk.mutate({ ids, action: "set_priority", value: v })} />
            <BulkMenu icon={<UserRound />} name="Assign selected" text="Assign" items={[{ value: "none", label: "Unassign" }, ...activeUsers.map((u) => ({ value: u.id, label: u.name }))]} onPick={(v) => bulk.mutate({ ids, action: "assign", value: v === "none" ? null : v })} />
            {isAdmin && <Button variant="ghost" className="text-red-300 hover:bg-white/10 hover:text-red-200" onClick={() => setConfirmDel(true)}><Trash2 />Delete</Button>}
            <Button variant="ghost" size="icon" className="ml-auto text-sidebar-foreground hover:bg-white/10" aria-label="Clear selection" onClick={() => setSel(new Set())}><X /></Button>
          </motion.div>)}
      </AnimatePresence>

      {open && <TicketDrawer id={open} onClose={() => setOpen(null)} />}
      {creating && <NewTicketModal onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); refresh(); setOpen(t.id); }} />}
      {confirmDel && <ConfirmModal title={`Delete ${sel.size} ticket${sel.size === 1 ? "" : "s"}`} danger confirm="Delete" busy={bulk.isPending} body="Tickets and their history are removed permanently." onConfirm={() => bulk.mutate({ ids, action: "delete" })} onClose={() => setConfirmDel(false)} />}
    </div>
  );
}

function BulkMenu({ icon, name, text, items, onPick }: { icon: React.ReactNode; name: string; text: string; items: Array<{ value: string; label: string }>; onPick: (v: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" aria-label={name} className="text-sidebar-foreground hover:bg-white/10 hover:text-white">{icon}{text}</Button></DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-72 overflow-y-auto">
        {items.map((i) => <DropdownMenuItem key={i.value} onSelect={() => onPick(i.value)}>{i.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Status menu on every card: the keyboard and touch alternative to dragging. */
function MoveMenu({ t, onMove }: { t: Ticket; onMove: (s: TicketStatus) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Move ticket ${t.number}`} className="-mr-1 shrink-0 text-muted-foreground"><ArrowRightLeft /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={t.status} onValueChange={(v) => { if (v !== t.status) onMove(v as TicketStatus); }}>
          {TICKET_STATUSES.map((s) => <DropdownMenuRadioItem key={s} value={s}><StatusDot s={s} />{label(s)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TicketCard({ t, canWrite, onOpen, onMove, draggable }: { t: Ticket; canWrite: boolean; onOpen: (id: string) => void; onMove: (s: TicketStatus) => void; draggable?: boolean }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div draggable={draggable && canWrite} onDragStart={(e) => { e.dataTransfer.setData("text/ticket", t.id); e.dataTransfer.effectAllowed = "move"; setDragging(true); }} onDragEnd={() => setDragging(false)}
      className={cn("group rounded-xl border bg-card p-3 shadow-[0_1px_2px_rgb(15_26_47/0.05)] transition-shadow hover:shadow-md", draggable && canWrite && "cursor-grab active:cursor-grabbing", dragging && "opacity-40")}>
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left outline-none focus-visible:underline" onClick={() => onOpen(t.id)}>
          <span className="font-mono text-xs text-muted-foreground">#{t.number}</span>
          <span className="mt-0.5 block text-[0.9375rem] font-medium leading-snug">{t.title}</span>
        </button>
        {canWrite && <MoveMenu t={t} onMove={onMove} />}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5"><PriorityBadge p={t.priority} /><SlaBadge t={t} />{(t.tags ?? []).slice(0, 2).map((g) => <Badge key={g.id} variant="outline"><span aria-hidden="true" className="size-2 rounded-full" style={{ background: g.color }} />{g.name}</Badge>)}</div>
      <div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
        {t.assigneeName ? <><Avatar className="size-5"><AvatarFallback className="text-[10px]">{initials(t.assigneeName)}</AvatarFallback></Avatar>{t.assigneeName}</> : <span>Unassigned</span>}
        <span className="ml-auto">{relTime(t.updatedAt)}</span>
      </div>
    </div>
  );
}

function Kanban({ board, canWrite, onOpen, onMove }: { board: Board; canWrite: boolean; onOpen: (id: string) => void; onMove: (id: string, s: TicketStatus) => void }) {
  const [over, setOver] = useState<TicketStatus | null>(null);
  return (
    <LayoutGroup>
      <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 xl:mx-0 xl:grid xl:grid-cols-5 xl:overflow-visible xl:px-0">
        {TICKET_STATUSES.map((s) => {
          const col = board.columns?.[s] ?? [];
          return (
            <section key={s} aria-labelledby={`col-${s}`}
              className={cn("w-72 shrink-0 snap-start rounded-2xl bg-muted/70 p-2.5 transition-colors xl:w-auto", over === s && "bg-accent ring-2 ring-primary/50")}
              onDragOver={(e) => { if (canWrite) { e.preventDefault(); setOver(s); } }} onDragLeave={() => setOver((o) => (o === s ? null : o))}
              onDrop={(e) => { setOver(null); const id = e.dataTransfer.getData("text/ticket"); const card = TICKET_STATUSES.flatMap((x) => board.columns?.[x] ?? []).find((x) => x.id === id); if (id && canWrite && card && card.status !== s) onMove(id, s); }}>
              <h2 id={`col-${s}`} className="mb-2.5 flex items-center gap-2 px-1.5 text-sm font-semibold"><StatusDot s={s} />{label(s)}<span className="ml-auto rounded-full bg-card px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{board.totals?.[s] ?? col.length}</span></h2>
              <ul className="min-h-16 space-y-2">
                {col.map((t) => (
                  <motion.li key={t.id} layoutId={`ticket-${t.id}`} layout transition={{ type: "spring", stiffness: 520, damping: 42 }}>
                    <TicketCard t={t} canWrite={canWrite} draggable onOpen={onOpen} onMove={(st) => onMove(t.id, st)} />
                  </motion.li>))}
              </ul>
              {col.length === 0 && <p className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed py-6 text-center text-sm text-muted-foreground">{canWrite && <GripVertical className="size-4" aria-hidden="true" />}No tickets</p>}
            </section>);
        })}
      </div>
    </LayoutGroup>
  );
}

/** Phones: tickets grouped by status, a segmented control switches groups. */
function PhoneList({ board, status, setStatus, canWrite, onOpen, onMove, onNew }: { board: Board; status: TicketStatus; setStatus: (s: TicketStatus) => void; canWrite: boolean; onOpen: (id: string) => void; onMove: (id: string, s: TicketStatus) => void; onNew: () => void }) {
  const col = useMemo(() => board.columns?.[status] ?? [], [board, status]);
  return (
    <div>
      <Segmented scroll label="Status" value={status} onChange={setStatus} className="mb-3 w-full"
        options={TICKET_STATUSES.map((s) => ({ value: s, label: label(s), count: board.totals?.[s] ?? board.columns?.[s]?.length ?? 0 }))} />
      {col.length === 0 ? <Empty title={`Nothing ${label(status).toLowerCase()}`} body="Tickets you move here show up in this list." action={canWrite && status === "open" && <Button onClick={onNew}><Plus />New ticket</Button>} /> : (
        <ul className="space-y-2.5" aria-label={`${label(status)} tickets`}>
          <AnimatePresence initial={false} mode="popLayout">
            {col.map((t) => (
              <motion.li key={t.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} transition={{ duration: 0.2 }}>
                <TicketCard t={t} canWrite={canWrite} onOpen={onOpen} onMove={(st) => onMove(t.id, st)} />
              </motion.li>))}
          </AnimatePresence>
        </ul>)}
    </div>
  );
}

function BoardSkeleton() {
  return <div role="status" aria-live="polite" className="space-y-3"><span className="sr-only">Loading board…</span>{[0, 1, 2].map((i) => <div key={i} className="skeleton h-24" style={{ opacity: 1 - i * 0.2 }} />)}</div>;
}

