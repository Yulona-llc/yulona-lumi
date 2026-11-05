import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ListFilter, ScrollText } from "lucide-react";
import { ag } from "../common/api";
import { AuditExport } from "../integrations-ui/AuditExport";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DatePicker, DateTimePicker, TimePickerInline } from "@/components/ui/date-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "../../components/ui";
import { Stagger, StaggerItem } from "@/components/motion";
import { Empty, ErrorState, fmtDate, Loading, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";

type Filters = { action: string; resourceType: string; from: string; to: string };
const NONE: Filters = { action: "", resourceType: "", from: "", to: "" };
const COLS = "lg:grid-cols-[10rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7rem]";

function FilterFields({ f, setF, onApply, onClear, compact }: { f: Filters; setF: (f: Filters) => void; onApply: () => void; onClear: () => void; compact?: boolean }) {
  return (
    <form className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"} onSubmit={(e) => { e.preventDefault(); onApply(); }}>
      <TextField label="Action" placeholder="agent.published" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
      <TextField label="Resource type" placeholder="agent" value={f.resourceType} onChange={(e) => setF({ ...f, resourceType: e.target.value })} />
      <DatePicker label="From" value={f.from} onChange={(v) => setF({ ...f, from: v })} />
      <DatePicker label="To" value={f.to} onChange={(v) => setF({ ...f, to: v })} />
      <div className="flex gap-2 sm:col-span-full sm:justify-end"><Button className="flex-1 sm:flex-none">Apply</Button><Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={onClear}>Clear</Button></div>
    </form>
  );
}

export default function AuditPage() {
  const { isAdmin } = useRole();
  const [f, setF] = useState<Filters>(NONE);
  const [applied, setApplied] = useState<Filters>(NONE);
  const [pop, setPop] = useState(false);
  const toIso = (d: string, end?: boolean) => (d ? new Date(`${d}T${end ? "23:59:59" : "00:00:00"}`).toISOString() : undefined);
  const q = useInfiniteQuery({
    queryKey: ["audit", applied], enabled: isAdmin, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => ag.audit({ action: applied.action || undefined, resourceType: applied.resourceType || undefined, from: toIso(applied.from), to: toIso(applied.to, true), cursor: pageParam }),
    getNextPageParam: (l) => l.nextCursor,
  });
  if (!isAdmin) return <><PageHeader title="Audit log" /><RoleNotice what="viewing the audit log" /></>;
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const active = Object.values(applied).filter(Boolean).length;
  const apply = () => { setApplied(f); setPop(false); };
  const clear = () => { setF(NONE); setApplied(NONE); setPop(false); };
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Sensitive actions in your workspace, newest first." actions={<AuditExport from={toIso(applied.from)} to={toIso(applied.to, true)} />} />
      <div className="mb-5 hidden rounded-2xl border bg-card p-4 sm:block"><FilterFields f={f} setF={setF} onApply={apply} onClear={clear} /></div>
      <div className="mb-4 flex items-center gap-2 sm:hidden">
        <Popover open={pop} onOpenChange={setPop}>
          <PopoverTrigger asChild><Button variant="outline"><ListFilter />Filters{active > 0 && <span className="grid size-5 place-items-center rounded-full bg-primary text-xs text-primary-foreground tabular-nums">{active}</span>}</Button></PopoverTrigger>
          <PopoverContent align="start" className="w-[22rem]"><FilterFields compact f={f} setF={setF} onApply={apply} onClear={clear} /></PopoverContent>
        </Popover>
        {active > 0 && <Button variant="ghost" onClick={clear}>Clear</Button>}
      </div>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : rows.length === 0 ? <Empty icon={<ScrollText className="size-6" />} title="No matching entries" body="Try widening the date range or clearing filters." action={active ? <Button variant="outline" onClick={clear}>Clear filters</Button> : undefined} /> : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className={`hidden gap-4 border-b bg-muted/50 px-4 py-2.5 text-xs font-medium text-muted-foreground lg:grid ${COLS}`} aria-hidden><span>When</span><span>Action</span><span>Resource</span><span>Actor</span><span>IP</span></div>
          <Stagger className="divide-y">
            {rows.map((r) => (
              <StaggerItem key={r.id} className={`grid gap-x-4 gap-y-1 px-4 py-3 ${COLS}`}>
                <p className="text-sm tabular-nums text-muted-foreground">{fmtDate(r.createdAt)}</p>
                <p className="break-all font-mono text-sm font-medium lg:text-xs">{r.action}</p>
                <p className="min-w-0 text-sm lg:text-xs">{r.resourceType ?? "-"}{r.resourceId && <span className="block truncate font-mono text-muted-foreground" title={r.resourceId}>{r.resourceId}</span>}</p>
                <p className="truncate font-mono text-xs text-muted-foreground" title={r.actorUserId ?? ""}>{r.actorUserId ?? "system"}</p>
                <p className="font-mono text-xs text-muted-foreground">{r.ip ?? "-"}</p>
              </StaggerItem>))}
          </Stagger>
        </div>)}
      {q.hasNextPage && <Button variant="outline" className="mt-4 w-full sm:w-auto" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage && <Spinner />}{q.isFetchingNextPage ? "Loading" : "Load more"}</Button>}
      {q.isFetchNextPageError && <div className="mt-3"><Alert variant="destructive"><AlertDescription>Could not load more entries.</AlertDescription></Alert></div>}
    </div>
  );
}
