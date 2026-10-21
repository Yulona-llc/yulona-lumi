import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { downloadAuthed } from "./http";

/** Audit log export (admin+). Mounted in the audit page header. */
export function AuditExport({ from, to }: { from?: string; to?: string }) {
  const [busy, setBusy] = useState<"csv" | "json" | null>(null);
  const [err, setErr] = useState("");
  const go = async (format: "csv" | "json") => {
    setBusy(format); setErr("");
    try {
      const p = new URLSearchParams({ format }); if (from) p.set("from", from); if (to) p.set("to", to);
      await downloadAuthed(`/audit-logs/export?${p}`, `audit-logs.${format}`);
      toast.success(`Exported audit log as ${format.toUpperCase()}`);
    } catch (e) { const m = e instanceof Error ? e.message : "Export failed"; setErr(m); toast.error(m); } finally { setBusy(null); }
  };
  return (
    <>
      <Button variant="outline" disabled={!!busy} onClick={() => void go("csv")}>{busy === "csv" ? <Loader2 className="animate-spin" /> : <Download />}Export CSV</Button>
      <Button variant="outline" disabled={!!busy} onClick={() => void go("json")}>{busy === "json" ? <Loader2 className="animate-spin" /> : <Download />}Export JSON</Button>
      {err && <span role="alert" className="basis-full text-sm text-destructive">{err}</span>}
    </>
  );
}
