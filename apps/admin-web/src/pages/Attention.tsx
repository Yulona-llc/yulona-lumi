import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { HealthBadge } from "@/components/bits";
import { Empty, ErrorState, Loading, PageHeader } from "@/components/common";
import { ago, titleCase } from "@/lib/format";

const PAGE = 25;

export default function Attention() {
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: keys.attention(PAGE, offset), queryFn: () => adminApi.attention(PAGE, offset), placeholderData: (p) => p });
  return (
    <div className="space-y-4">
      <PageHeader title="Needs attention" subtitle="Active customers whose health is Watch or At risk, worst first. Open one to see why and what to check." />
      {q.isPending ? <Loading rows={5} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty icon={<PartyPopper className="size-6" />} title="All clear" body="No active customer is on watch or at risk." /> : (
          <div className="rounded-xl border bg-card">
            <ul className="divide-y">
              {q.data.items.map((a) => (
                <li key={a.id}>
                  <Link to={`/customers/${a.id}?tab=issues`} className="grid gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-muted/40 md:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_auto] md:items-center">
                    <div className="min-w-0"><p className="truncate font-medium">{a.name}</p><p className="truncate text-xs text-muted-foreground">{titleCase(a.plan)} · {a.ownerEmail ?? "no owner"} · active {ago(a.lastActiveAt)}</p></div>
                    <ul className="flex flex-wrap gap-1.5" aria-label="Reasons">{a.health.reasons.slice(0, 3).map((r) => <li key={r.code} className="rounded-md bg-muted px-2 py-0.5 text-xs">{r.label}</li>)}{a.health.reasons.length > 3 && <li className="px-1 text-xs text-muted-foreground">+{a.health.reasons.length - 3} more</li>}</ul>
                    <div className="flex items-center gap-3 md:justify-end">{a.errorCount7d > 0 && <span className="text-xs font-medium tabular-nums text-destructive">{a.errorCount7d} errors, 7d</span>}<HealthBadge health={a.health} /></div>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
              <span className="text-muted-foreground tabular-nums">{offset + 1}-{offset + q.data.items.length} of {q.data.total}</span>
              <div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft aria-hidden />Previous</Button><Button variant="outline" size="sm" disabled={offset + PAGE >= q.data.total} onClick={() => setOffset(offset + PAGE)}>Next<ChevronRight aria-hidden /></Button></div>
            </div>
          </div>
        )}
    </div>
  );
}
