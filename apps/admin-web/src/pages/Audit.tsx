import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { Gated } from "@/components/bits";
import { Empty, ErrorState, Loading, PageHeader, Select, TextField } from "@/components/common";
import { fmtDate } from "@/lib/format";
import { errMsg } from "@/lib/errors";
import { Link } from "react-router";

const PAGE = 50;
const GROUPS = [["", "Every action"], ["admin.", "Admin accounts and sign-ins"], ["tenant.", "Customer views and changes"], ["credits.", "Credits"], ["impersonation.", "Impersonation"], ["job.", "Jobs"], ["flag.", "Feature flags"], ["plan.", "Plan limits"], ["customers.export", "Customer exports"]];

export default function Audit() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => {
    const f: Record<string, string | number | undefined> = {};
    for (const k of ["adminId", "tenantId", "action", "from", "to"]) { const v = sp.get(k); if (v) f[k] = v; }
    return f;
  }, [sp]);
  const page = Math.max(1, Number(sp.get("page") ?? 1));
  const query = { ...filters, limit: PAGE, offset: (page - 1) * PAGE };
  const set = (patch: Record<string, string | undefined>, keep = false) => setSp((cur) => { const n = new URLSearchParams(cur); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } if (!keep) n.delete("page"); return n; }, { replace: true });
  const [action, setAction] = useState((filters.action as string) ?? "");
  useEffect(() => { const t = setTimeout(() => { if ((filters.action ?? "") !== action.trim()) set({ action: action.trim() || undefined }); }, 350); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [action]);
  const q = useQuery({ queryKey: keys.audit(query), queryFn: () => adminApi.audit(query), placeholderData: (p) => p });
  const admins = useQuery({ queryKey: keys.admins, queryFn: adminApi.admins, enabled: can("manageAdmins") });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exp = async (f: "csv" | "json") => { setBusy(true); try { await adminApi.exportAudit(filters, f); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); } };
  const total = q.data?.total ?? 0;
  const n = q.data?.items.length ?? 0;
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" subtitle="Every admin sign-in, customer view, export and change. Rows cannot be edited or removed."
        actions={<><Gated allowed={can("exportAudit")} reason={whoCan("exportAudit")}><Button variant="outline" disabled={busy} onClick={() => void exp("csv")}><Download aria-hidden />Export CSV</Button></Gated>
          <Gated allowed={can("exportAudit")} reason={whoCan("exportAudit")}><Button variant="outline" disabled={busy} onClick={() => void exp("json")}><Download aria-hidden />Export JSON</Button></Gated></>} />
      <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Select label="Group" value={GROUPS.some(([v]) => v === filters.action) ? (filters.action as string) : ""} onChange={(e) => { setAction(e.target.value); set({ action: e.target.value || undefined }); }}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <TextField label="Action" value={action} onChange={(e) => setAction(e.target.value)} placeholder="tenant.view or tenant." className="font-mono" />
        {can("manageAdmins")
          ? <Select label="Admin" value={(filters.adminId as string) ?? ""} onChange={(e) => set({ adminId: e.target.value || undefined })}><option value="">Anyone</option>{admins.data?.items.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select>
          : <div />}
        <TextField label="From" type="date" value={(filters.from as string) ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        <TextField label="To" type="date" value={(filters.to as string) ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
        {filters.tenantId && <div className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-5"><span className="text-muted-foreground">Filtered to one customer.</span><Button variant="ghost" size="sm" onClick={() => set({ tenantId: undefined })}>Clear</Button></div>}
      </div>
      {q.isPending ? <Loading rows={5} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : n === 0 ? <Empty title="No matching entries" body="Change the filters to see more." /> : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table className="min-w-[44rem]">
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Admin</TableHead><TableHead>Action</TableHead><TableHead>Customer</TableHead><TableHead className="w-10"><span className="sr-only">Details</span></TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data.items.map((r) => {
                  const hasMeta = !!r.metadata && typeof r.metadata === "object" && Object.keys(r.metadata as object).length > 0;
                  return (
                    <Fragment key={r.id}>
                      <TableRow>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(r.createdAt)}</TableCell>
                        <TableCell>{r.adminEmail ?? "system"}</TableCell>
                        <TableCell className="font-mono text-xs">{r.action}</TableCell>
                        <TableCell>{r.tenantId ? <Link className="underline-offset-4 hover:underline" to={`/customers/${r.tenantId}`}>{r.tenantName ?? r.tenantId.slice(0, 8)}</Link> : <span className="text-muted-foreground">Platform</span>}</TableCell>
                        <TableCell>{hasMeta && <Button variant="ghost" size="icon-sm" aria-expanded={open === r.id} aria-label="Show details" onClick={() => setOpen(open === r.id ? null : r.id)}><ChevronDown className={open === r.id ? "rotate-180" : ""} /></Button>}</TableCell>
                      </TableRow>
                      {open === r.id && <TableRow><TableCell colSpan={5} className="bg-muted/40"><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(r.metadata, null, 2)}</pre></TableCell></TableRow>}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
            <span className="text-muted-foreground tabular-nums">{query.offset + 1}-{query.offset + n} of {total}</span>
            <div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) }, true)}><ChevronLeft aria-hidden />Newer</Button><Button variant="outline" size="sm" disabled={query.offset + n >= total} onClick={() => set({ page: String(page + 1) }, true)}>Older<ChevronRight aria-hidden /></Button></div>
          </div>
        </div>
      )}
    </div>
  );
}
