import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, MoreHorizontal, Rows3, Rows4, Search, SlidersHorizontal, Tag, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TenantFilters, TenantListItem } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { CreditsBadge, Gated, HealthBadge, StatusBadge } from "@/components/bits";
import { ConfirmModal, Empty, ErrorState, Loading, Modal, PageHeader, Select, Spinner, TextField } from "@/components/common";
import { ago, fmtCredits, fmtDate, titleCase } from "@/lib/format";
import { errMsg } from "@/lib/errors";
import { cn } from "@/lib/utils";

const PAGE = 25;
const FILTER_KEYS = ["q", "status", "plan", "health", "credits", "hasErrors", "inactiveDays", "tag", "createdFrom", "createdTo"] as const;

/** Filters, sort and page live in the URL so a view can be shared and survives reload. */
export function useTenantFilters() {
  const [sp, setSp] = useSearchParams();
  const filters: TenantFilters = useMemo(() => {
    const f: Record<string, string | number> = {};
    for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) f[k] = v; }
    f.sort = sp.get("sort") ?? "createdAt";
    f.order = sp.get("order") ?? "desc";
    f.limit = PAGE;
    f.offset = Math.max(0, (Number(sp.get("page") ?? 1) - 1) * PAGE);
    return f as TenantFilters;
  }, [sp]);
  const set = (patch: Record<string, string | undefined>, keepPage = false) => setSp((cur) => {
    const n = new URLSearchParams(cur);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    if (!keepPage) n.delete("page");
    return n;
  }, { replace: true });
  return { sp, filters, set, page: Math.max(1, Number(sp.get("page") ?? 1)), activeCount: FILTER_KEYS.filter((k) => k !== "q" && sp.get(k)).length };
}

function SortHead({ label, field, f, set, className }: { label: string; field: string; f: TenantFilters; set: (p: Record<string, string | undefined>) => void; className?: string }) {
  const on = f.sort === field;
  return (
    <TableHead className={className} aria-sort={on ? (f.order === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => set({ sort: field, order: on && f.order === "desc" ? "asc" : "desc" })}>
        {label}{on ? (f.order === "asc" ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />) : null}
      </button>
    </TableHead>
  );
}

function BulkTag({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");
  const tags = useQuery({ queryKey: keys.allTags, queryFn: adminApi.allTags });
  const list = (s: string) => s.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const m = useMutation({ mutationFn: () => adminApi.bulkTags(ids, list(add), list(remove)), onSuccess: (r) => { toast.success(`Updated ${r.updated} customers`); onDone(); } });
  return (
    <Modal title={`Tag ${ids.length} customers`} description="Lowercase letters, digits, dashes and underscores. Separate tags with commas." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        {m.isError && <Alert variant="destructive">{errMsg(m.error)}</Alert>}
        <TextField label="Add tags" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="vip, onboarding" className="font-mono" />
        <TextField label="Remove tags" value={remove} onChange={(e) => setRemove(e.target.value)} placeholder="churn-risk" className="font-mono" />
        {(tags.data?.items.length ?? 0) > 0 && <p className="text-xs text-muted-foreground">In use: {tags.data!.items.map((t) => `${t.tag} (${t.count})`).join(", ")}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || (!list(add).length && !list(remove).length)}>{m.isPending && <Spinner />}Apply</Button></div>
      </form>
    </Modal>
  );
}

function RowMenu({ t, onAction }: { t: TenantListItem; onAction: (a: "suspend" | "unsuspend" | "restore") => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const life = can("tenantLifecycle");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => nav(`/customers/${t.id}`)}><ExternalLink />Open customer</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(t.id).then(() => toast.success("ID copied"))}><Copy />Copy ID</DropdownMenuItem>
        {t.ownerEmail && <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(t.ownerEmail!).then(() => toast.success("Email copied"))}><Copy />Copy owner email</DropdownMenuItem>}
        {life && <DropdownMenuSeparator />}
        {life && t.status === "active" && <DropdownMenuItem destructive onSelect={() => onAction("suspend")}>Suspend</DropdownMenuItem>}
        {life && t.status === "suspended" && <DropdownMenuItem onSelect={() => onAction("unsuspend")}>Restore access</DropdownMenuItem>}
        {life && t.status === "deleted" && <DropdownMenuItem onSelect={() => onAction("restore")}>Restore customer</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function Customers() {
  const { filters, set, sp, page, activeCount } = useTenantFilters();
  const { can } = useAuth();
  const [q, setQ] = useState(filters.q ?? "");
  const [showFilters, setShowFilters] = useState(activeCount > 0);
  const [dense, setDense] = useState(() => { try { return localStorage.getItem("lumi-admin-density") === "compact"; } catch { return false; } });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [confirm, setConfirm] = useState<{ t: TenantListItem; a: "suspend" | "unsuspend" | "restore" } | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => { if ((filters.q ?? "") !== q.trim()) set({ q: q.trim() || undefined }); }, 300); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q]);
  useEffect(() => { try { localStorage.setItem("lumi-admin-density", dense ? "compact" : "comfortable"); } catch { /* ignore */ } }, [dense]);

  const list = useQuery({ queryKey: keys.tenants(filters), queryFn: () => adminApi.tenants(filters), placeholderData: (p) => p });
  const plans = useQuery({ queryKey: keys.plans, queryFn: adminApi.plans, staleTime: 300_000 });
  const tags = useQuery({ queryKey: keys.allTags, queryFn: adminApi.allTags, staleTime: 60_000 });
  const act = useMutation({
    mutationFn: ({ t, a }: { t: TenantListItem; a: "suspend" | "unsuspend" | "restore" }) => adminApi.tenantAction(t.id, a),
    onSuccess: () => { setConfirm(null); toast.success("Customer updated"); }, onError: (e) => toast.error(errMsg(e)),
  });
  const doExport = async () => {
    setExporting(true);
    try { await adminApi.exportTenants(filters); } catch (e) { toast.error(errMsg(e)); } finally { setExporting(false); }
  };
  useEffect(() => { if (sp.get("export") === "1") { set({ export: undefined }, true); void doExport(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const allOn = items.length > 0 && items.every((t) => sel.has(t.id));
  const pad = dense ? "py-1.5" : "py-3";
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clear = () => { setQ(""); set({ q: undefined, status: undefined, plan: undefined, health: undefined, credits: undefined, hasErrors: undefined, inactiveDays: undefined, tag: undefined, createdFrom: undefined, createdTo: undefined }); };

  return (
    <div className="space-y-4">
      <PageHeader title="Customers" subtitle="Every workspace on the platform. Search by name, ID or any team member's email."
        actions={<Button variant="outline" onClick={() => void doExport()} disabled={exporting}>{exporting ? <Spinner /> : <Download aria-hidden />}Export CSV</Button>} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID or email" aria-label="Search customers" className="pl-9" />
        </div>
        <Button variant="outline" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}><SlidersHorizontal aria-hidden />Filters{activeCount > 0 && <Badge variant="default">{activeCount}</Badge>}</Button>
        <div role="group" aria-label="Row density" className="ml-auto inline-flex rounded-lg border p-0.5">
          <Button variant={dense ? "ghost" : "secondary"} size="icon-sm" aria-pressed={!dense} aria-label="Comfortable rows" onClick={() => setDense(false)}><Rows3 /></Button>
          <Button variant={dense ? "secondary" : "ghost"} size="icon-sm" aria-pressed={dense} aria-label="Compact rows" onClick={() => setDense(true)}><Rows4 /></Button>
        </div>
      </div>

      {showFilters && (
        <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="Status" value={filters.status ?? ""} onChange={(e) => set({ status: e.target.value || undefined })}><option value="">Any</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="deleted">Deleted</option></Select>
          <Select label="Plan" value={filters.plan ?? ""} onChange={(e) => set({ plan: e.target.value || undefined })}><option value="">Any</option>{plans.data?.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</Select>
          <Select label="Health" value={filters.health ?? ""} onChange={(e) => set({ health: e.target.value || undefined })}><option value="">Any</option><option value="healthy">Healthy</option><option value="watch">Watch</option><option value="at_risk">At risk</option></Select>
          <Select label="Credits" value={filters.credits ?? ""} onChange={(e) => set({ credits: e.target.value || undefined })}><option value="">Any</option><option value="ok">OK</option><option value="low">Low</option><option value="exhausted">Exhausted</option><option value="unlimited">Unlimited</option></Select>
          <Select label="Last active" value={filters.inactiveDays ?? ""} onChange={(e) => set({ inactiveDays: e.target.value || undefined })}><option value="">Any time</option><option value="7">Inactive 7+ days</option><option value="14">Inactive 14+ days</option><option value="30">Inactive 30+ days</option></Select>
          <Select label="Errors" value={filters.hasErrors ?? ""} onChange={(e) => set({ hasErrors: e.target.value || undefined })}><option value="">Any</option><option value="true">Has errors in the last 7 days</option></Select>
          <Select label="Tag" value={filters.tag ?? ""} onChange={(e) => set({ tag: e.target.value || undefined })}><option value="">Any</option>{tags.data?.items.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}</Select>
          <div className="grid grid-cols-2 gap-2"><TextField label="Created from" type="date" value={filters.createdFrom ?? ""} onChange={(e) => set({ createdFrom: e.target.value || undefined })} /><TextField label="Created to" type="date" value={filters.createdTo ?? ""} onChange={(e) => set({ createdTo: e.target.value || undefined })} /></div>
          <div className="sm:col-span-2 lg:col-span-4"><Button variant="ghost" size="sm" onClick={clear}><X aria-hidden />Clear all filters</Button></div>
        </div>
      )}

      {sel.size > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-accent px-4 py-2.5 text-sm">
          <span className="font-medium">{sel.size} selected</span>
          <Gated allowed={can("notesAndTags")} reason={whoCan("notesAndTags")}><Button size="sm" variant="outline" onClick={() => setBulk(true)}><Tag aria-hidden />Tag</Button></Gated>
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear selection</Button>
        </div>
      )}

      {list.isPending ? <Loading label="Loading customers" rows={6} /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} />
        : items.length === 0 ? <Empty title="No customers match" body="Loosen the search or filters to see more." action={<Button variant="outline" onClick={clear}>Clear filters</Button>} /> : (
          <div className={cn("overflow-hidden rounded-xl border bg-card transition-opacity", list.isPlaceholderData && "opacity-60")}>
            <div className="overflow-x-auto">
              <Table className="min-w-[56rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"><Checkbox checked={allOn} onCheckedChange={(v) => setSel(v === true ? new Set([...sel, ...items.map((t) => t.id)]) : new Set([...sel].filter((id) => !items.some((t) => t.id === id))))} aria-label="Select all on this page" /></TableHead>
                    <SortHead label="Customer" field="name" f={filters} set={set} />
                    <TableHead>Plan</TableHead>
                    <SortHead label="Health" field="health" f={filters} set={set} />
                    <SortHead label="Credits" field="credits" f={filters} set={set} />
                    <SortHead label="Errors, 7d" field="errors" f={filters} set={set} className="text-right" />
                    <SortHead label="Last active" field="lastActive" f={filters} set={set} />
                    <SortHead label="Created" field="createdAt" f={filters} set={set} className="max-lg:hidden" />
                    <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((t) => (
                    <TableRow key={t.id} data-state={sel.has(t.id) ? "selected" : undefined}>
                      <TableCell className={pad}><Checkbox checked={sel.has(t.id)} onCheckedChange={() => toggle(t.id)} aria-label={`Select ${t.name}`} /></TableCell>
                      <TableCell className={cn(pad, "max-w-72")}>
                        <Link to={`/customers/${t.id}`} className="block min-w-0 font-medium hover:underline"><span className="truncate">{t.name}</span></Link>
                        <p className="truncate text-xs text-muted-foreground">{t.ownerEmail ?? "No owner"} · {t.userCount} {t.userCount === 1 ? "user" : "users"}</p>
                        {(t.status !== "active" || t.tags.length > 0) && <div className="mt-1 flex flex-wrap gap-1">{t.status !== "active" && <StatusBadge status={t.status} />}{t.tags.map((g) => <Badge key={g} variant="outline" className="font-mono text-[0.7rem]">{g}</Badge>)}</div>}
                      </TableCell>
                      <TableCell className={pad}>{titleCase(t.plan)}</TableCell>
                      <TableCell className={pad}><HealthBadge health={t.health} /></TableCell>
                      <TableCell className={pad}><div className="flex flex-col items-start gap-0.5"><CreditsBadge state={t.credits.state} />{t.credits.remainingMicro !== null && <span className="text-xs tabular-nums text-muted-foreground">{fmtCredits(t.credits.remainingMicro)} left</span>}</div></TableCell>
                      <TableCell className={cn(pad, "text-right tabular-nums", t.errorCount7d > 0 && "font-medium text-destructive")}>{t.errorCount7d}</TableCell>
                      <TableCell className={cn(pad, "whitespace-nowrap")} title={fmtDate(t.lastActiveAt)}>{ago(t.lastActiveAt)}</TableCell>
                      <TableCell className={cn(pad, "whitespace-nowrap text-muted-foreground max-lg:hidden")}>{new Date(t.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className={pad}><RowMenu t={t} onAction={(a) => setConfirm({ t, a })} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-sm">
              <span className="text-muted-foreground tabular-nums">{filters.offset! + 1}-{filters.offset! + items.length} of {total}</span>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) }, true)}><ChevronLeft aria-hidden />Previous</Button>
                <Button variant="outline" size="sm" disabled={filters.offset! + items.length >= total} onClick={() => set({ page: String(page + 1) }, true)}>Next<ChevronRight aria-hidden /></Button>
              </div>
            </div>
          </div>
        )}
      {bulk && <BulkTag ids={[...sel]} onClose={() => setBulk(false)} onDone={() => { setBulk(false); setSel(new Set()); }} />}
      {confirm && <ConfirmModal danger={confirm.a === "suspend"} title={confirm.a === "suspend" ? "Suspend this customer?" : confirm.a === "unsuspend" ? "Restore access?" : "Restore this customer?"}
        body={<>{confirm.a === "suspend" ? <>Everyone in <strong>{confirm.t.name}</strong> is signed out and blocked until restored.</> : <><strong>{confirm.t.name}</strong> becomes usable again.</>}</>}
        confirm={confirm.a === "suspend" ? "Suspend" : "Restore"} busy={act.isPending} onConfirm={() => act.mutate(confirm)} onClose={() => setConfirm(null)} />}
    </div>
  );
}
