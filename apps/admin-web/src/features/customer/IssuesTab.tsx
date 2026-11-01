import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { ErrorKind } from "@/api/types";
import { Empty, ErrorState, Loading, Select, Spinner } from "@/components/common";
import { ago, fmtDate } from "@/lib/format";
import { errMsg } from "@/lib/errors";

export const KIND_LABEL: Record<ErrorKind, string> = {
  job_failed: "Background job failed", webhook_delivery_failed: "Webhook delivery failed", channel_error: "Channel error", channel_delivery_failed: "Channel delivery failed",
  knowledge_ingest_failed: "Knowledge ingest failed", notification_email_failed: "Notification email failed", crm_sync_failed: "CRM sync failed",
  handoff_system_failure: "Handoff: system failure", abuse_handoff: "Abuse block", tool_failed: "Tool call failed",
};

export default function IssuesTab({ id }: { id: string }) {
  const [kind, setKind] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: keys.issues(id, kind, days), queryFn: () => adminApi.issues(id, kind, days), placeholderData: (p) => p });
  const exp = async () => { setBusy(true); try { await adminApi.exportIssues(id, kind, days); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64"><Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{(Object.keys(KIND_LABEL) as ErrorKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}{q.data?.counts[k] ? ` (${q.data.counts[k]})` : ""}</option>)}</Select></div>
        <div className="w-40"><Select label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}><option value="1">Last day</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></Select></div>
        <Button variant="outline" className="sm:ml-auto" onClick={() => void exp()} disabled={busy}>{busy ? <Spinner /> : <Download aria-hidden />}Export CSV</Button>
      </div>
      {q.isPending ? <Loading rows={4} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : q.data.items.length === 0 ? <Empty title="No issues" body="Nothing failed for this customer in the selected period." /> : (
          <ul className="space-y-2.5">
            {q.data.items.map((i, n) => (
              <li key={`${i.refId}-${n}`} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2"><Badge variant="destructive">{KIND_LABEL[i.kind] ?? i.kind}</Badge><span className="min-w-0 flex-1 break-words text-sm font-medium">{i.title}</span><time className="text-xs text-muted-foreground" title={fmtDate(i.at)}>{ago(i.at)}</time></div>
                {i.detail && <pre className="mt-2.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5 font-mono text-xs">{i.detail}</pre>}
                {i.hint && <p className="mt-2.5 flex items-start gap-2 text-sm text-muted-foreground"><Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /><span><span className="font-medium text-foreground">What to check: </span>{i.hint}</span></p>}
              </li>
            ))}
          </ul>
        )}
      {q.data && q.data.total > q.data.items.length && <p className="text-xs text-muted-foreground">Showing the newest {q.data.items.length} of {q.data.total}. Export the CSV for all of them.</p>}
    </div>
  );
}
