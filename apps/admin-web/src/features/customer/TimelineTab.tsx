import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Empty, ErrorState, Loading, Select } from "@/components/common";
import { fmtDate, titleCase } from "@/lib/format";

const SOURCES = ["tenant_audit", "platform_audit", "billing", "handoff", "impersonation"];
const PAGE = 30;

export default function TimelineTab({ id }: { id: string }) {
  const [source, setSource] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: keys.timeline(id, source, offset), queryFn: () => adminApi.timeline(id, source, PAGE, offset), placeholderData: (p) => p });
  return (
    <div className="space-y-4">
      <div className="w-full sm:w-64"><Select label="Source" value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }}><option value="">Everything</option>{SOURCES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></div>
      {q.isPending ? <Loading rows={4} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.items.length === 0 ? <Empty title="Nothing yet" body="No events were recorded for this customer." /> : (
        <div className="rounded-xl border bg-card">
          <ol className="divide-y">
            {q.data.items.map((e, i) => (
              <li key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
                <time className="w-40 shrink-0 text-xs text-muted-foreground">{fmtDate(e.at)}</time>
                <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{e.action}</p><p className="text-xs text-muted-foreground">{[e.actor, e.resourceType].filter(Boolean).join(" · ")}</p></div>
                <Badge variant="outline">{titleCase(e.source)}</Badge>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
            <span className="text-muted-foreground tabular-nums">{offset + 1}-{offset + q.data.items.length} of {q.data.total}</span>
            <div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft aria-hidden />Newer</Button><Button variant="outline" size="sm" disabled={offset + PAGE >= q.data.total} onClick={() => setOffset(offset + PAGE)}>Older<ChevronRight aria-hidden /></Button></div>
          </div>
        </div>
      )}
    </div>
  );
}
