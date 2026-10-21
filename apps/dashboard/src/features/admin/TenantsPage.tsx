import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Badge, Empty, ErrorState, fmtDate, Loading, PageHeader } from "../common/ui";
import { adminApi, type TenantRow } from "./api";

const PAGE = 25;
const FILTERS = [["all", "All"], ["active", "Active"], ["suspended", "Suspended"], ["deleted", "Deleted"]] as const;
const statusOf = (t: TenantRow) => (t.deletedAt ? "deleted" : t.status);
const tone = (s: string) => (s === "deleted" ? "gray" : s === "active" ? "green" : "amber") as "gray" | "green" | "amber";

export default function TenantsPage() {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const r = useQuery({ queryKey: ["admin", "tenants", applied, page], queryFn: () => adminApi.tenants({ q: applied, limit: PAGE, offset: page * PAGE }), placeholderData: (p) => p });
  const rows = (r.data?.items ?? []).filter((t) => filter === "all" || statusOf(t) === filter);
  return (
    <div>
      <PageHeader title="Tenants" subtitle="Every workspace on the platform. Open one to see usage, change its status or support it." />
      <form className="mb-3 flex gap-2" role="search" onSubmit={(e) => { e.preventDefault(); setPage(0); setApplied(q.trim()); }}>
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search by name" placeholder="Search by name" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button type="submit">Search</Button>
      </form>
      <div role="group" aria-label="Status filter" className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={cn("min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium", filter === k ? "border-primary bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted")}>{l}</button>)}
      </div>
      {r.isPending ? <Loading /> : r.isError ? <ErrorState error={r.error} retry={() => void r.refetch()} /> : rows.length === 0 ? <Empty title="No tenants found" body="Try a different search or status filter." /> : (<>
        <ul className="grid gap-3 md:hidden">
          {rows.map((t) => (
            <li key={t.id}><Link to={`/admin/tenants/${t.id}`} className="block"><Card className="gap-2 p-4 active:bg-muted">
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{t.name}</span><Badge color={tone(statusOf(t))}>{statusOf(t)}</Badge></div>
              <div className="flex items-center justify-between text-sm text-muted-foreground"><span>{t.plan} plan, {t.userCount} {t.userCount === 1 ? "user" : "users"}</span><ChevronRight className="size-4" aria-hidden /></div>
              <p className="text-xs text-muted-foreground">Created {fmtDate(t.createdAt)}</p>
            </Card></Link></li>))}
        </ul>
        <Card className="hidden overflow-hidden p-0 md:block"><table className="w-full text-left text-sm"><caption className="sr-only">Tenants</caption>
          <thead className="border-b bg-muted/50 text-muted-foreground"><tr><th scope="col" className="p-3 font-medium">Name</th><th scope="col" className="font-medium">Status</th><th scope="col" className="font-medium">Plan</th><th scope="col" className="font-medium">Users</th><th scope="col" className="font-medium">Created</th></tr></thead>
          <tbody>{rows.map((t) => <tr key={t.id} className="border-b last:border-0 hover:bg-muted/40"><td className="p-3"><Link className="font-medium underline-offset-4 hover:underline" to={`/admin/tenants/${t.id}`}>{t.name}</Link></td>
            <td><Badge color={tone(statusOf(t))}>{statusOf(t)}</Badge></td><td>{t.plan}</td><td className="tabular-nums">{t.userCount}</td><td>{fmtDate(t.createdAt)}</td></tr>)}</tbody></table></Card>
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground"><span>{r.data.total} tenants</span><span className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= r.data.total} onClick={() => setPage(page + 1)}>Next</Button></span></div></>)}
    </div>
  );
}
