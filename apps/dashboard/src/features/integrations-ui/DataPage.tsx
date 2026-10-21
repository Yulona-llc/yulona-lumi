import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, FileDown, Loader2, ShieldCheck, Trash2, UserX } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { Stagger, StaggerItem } from "@/components/motion";
import { errMsg } from "../common/api";
import { Empty, ErrorState, fmtBytes, fmtDate, Loading, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";
import { downloadAuthed } from "./http";
import { intApi, type GdprRequest, type Retention } from "./api";

const FIELDS: Array<[keyof Retention & string, string, number, number]> = [
  ["messagesDays", "Messages", 7, 3650], ["auditLogsDays", "Audit logs", 30, 3650], ["webhookLogsDays", "Webhook delivery logs", 1, 365], ["toolLogsDays", "AI tool logs", 7, 3650],
];

function RetentionCard() {
  const q = useQuery({ queryKey: ["retention"], queryFn: intApi.retention });
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => { if (q.data) setV(Object.fromEntries(FIELDS.map(([k]) => [k, q.data![k] == null ? "" : String(q.data![k])]))); }, [q.data]);
  const m = useMutation({
    mutationFn: () => intApi.setRetention(Object.fromEntries(FIELDS.map(([k]) => [k, v[k] ? Number(v[k]) : null])) as unknown as Retention),
    onSuccess: () => { void q.refetch(); toast.success("Retention saved"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  return (
    <Card>
      <div><h2 className="font-display text-lg font-semibold">Data retention</h2><p className="mt-1 text-sm text-muted-foreground">Older records are deleted automatically. Leave a field empty to keep data forever. Live conversations keep their history.</p></div>
      {m.isError && <Alert variant="destructive"><AlertTriangle /><AlertDescription>{errMsg(m.error)}</AlertDescription></Alert>}
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        {FIELDS.map(([k, label, min, max]) => <TextField key={k} label={`${label} (days)`} type="number" inputMode="numeric" min={min} max={max} placeholder="Keep forever" value={v[k] ?? ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} hint={`${min} to ${max} days`} />)}
        <div className="sm:col-span-2"><Button type="submit" disabled={m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Save retention</Button></div>
      </form>
    </Card>
  );
}

const sTone = { queued: "secondary", processing: "info", completed: "success", failed: "destructive" } as const;
const sPct = { queued: 12, processing: 55, completed: 100, failed: 100 } as const;
const sText = { queued: "Waiting to start", processing: "Preparing", completed: "Ready", failed: "Failed" } as const;

/** Destructive confirmation: the button stays disabled until the person types the word. */
function EraseDialog({ contactId, busy, onConfirm, onClose }: { contactId: string; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const ok = typed.trim().toLowerCase() === "erase";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 grid size-12 place-items-center rounded-2xl bg-destructive/10 text-destructive"><UserX className="size-6" /></span>
          <DialogTitle>Erase this contact?</DialogTitle>
          <DialogDescription>This irreversibly anonymises the contact and replaces all their messages with "[erased]". Tickets, bookings and transactions referencing them are kept and listed for follow-up.</DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs">{contactId}</p>
        <div className="grid gap-1.5">
          <Label htmlFor="erase-confirm">Type erase to confirm</Label>
          <Input id="erase-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="erase" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!ok || busy} onClick={onConfirm}>{busy && <Loader2 className="animate-spin" />}Erase permanently</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestRow({ r, onDownload, busy }: { r: GdprRequest; onDownload: () => void; busy: boolean }) {
  const active = r.status === "queued" || r.status === "processing";
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium capitalize">{r.kind}</span>
          <Badge variant={sTone[r.status]}>{r.status}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{r.contactId ? r.contactId.slice(0, 8) : "workspace"}</span>
        </div>
        <p className="text-sm text-muted-foreground">Requested {fmtDate(r.createdAt)}{r.sizeBytes ? ` · ${fmtBytes(r.sizeBytes)}` : ""}</p>
        {active && (
          <div className="flex items-center gap-3" role="status"><Progress value={sPct[r.status]} aria-label={`${r.kind} progress`} className="h-1.5 max-w-48" /><span className="text-xs text-muted-foreground">{sText[r.status]}</span></div>
        )}
        {r.error && <p className="text-sm text-destructive">{r.error}</p>}
      </div>
      {r.kind === "export" && r.downloadAvailable && <Button variant="outline" size="sm" disabled={busy} onClick={onDownload}><Download />Download</Button>}
    </li>
  );
}

function GdprCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["gdpr"], queryFn: intApi.gdpr, refetchInterval: (s) => (s.state.data?.some((r) => r.status === "queued" || r.status === "processing") ? 4000 : false) });
  const [contactId, setContactId] = useState("");
  const [erase, setErase] = useState(false);
  const idOk = /^[0-9a-f-]{36}$/i.test(contactId.trim());
  const inv = () => void qc.invalidateQueries({ queryKey: ["gdpr"] });
  const exp = useMutation({ mutationFn: (id?: string) => intApi.gdprExport(id), onSuccess: () => { inv(); toast.success("Export requested"); }, onError: (e) => toast.error(errMsg(e)) });
  const er = useMutation({ mutationFn: () => intApi.gdprErase(contactId.trim()), onSuccess: () => { setErase(false); setContactId(""); inv(); toast.success("Erasure requested"); }, onError: (e) => toast.error(errMsg(e)) });
  const dl = useMutation({
    mutationFn: async (r: GdprRequest) => { const x = await intApi.gdprDownload(r.id).catch(() => null); if (x?.url) window.open(x.url, "_blank", "noopener"); else await downloadAuthed(`/gdpr/requests/${r.id}/download`, `gdpr-export-${r.id}.json`); },
    onSuccess: () => toast.success("Download started"), onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Card>
      <div><h2 className="font-display text-lg font-semibold">Privacy requests (GDPR)</h2><p className="mt-1 text-sm text-muted-foreground">Export a contact's data or the whole workspace, or permanently anonymise a contact. Exports expire after 7 days.</p></div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <TextField label="Contact ID (optional for export)" value={contactId} onChange={(e) => setContactId(e.target.value)} placeholder="UUID from the contact page URL" error={contactId && !idOk ? "Enter the full 36-character contact ID." : undefined} />
        <Button variant="outline" disabled={exp.isPending || (!!contactId && !idOk)} onClick={() => exp.mutate(contactId.trim() || undefined)}>{exp.isPending ? <Loader2 className="animate-spin" /> : <FileDown />}{contactId ? "Export contact" : "Export workspace"}</Button>
        <Button variant="destructive" disabled={!idOk} onClick={() => setErase(true)}><Trash2 />Erase contact</Button>
      </div>
      {q.isPending ? <Loading rows={2} /> : q.isError ? <ErrorState error={q.error} />
        : q.data.length === 0 ? <Empty icon={<ShieldCheck className="size-6" />} title="No requests yet" body="Exports and erasures you create appear here with their progress." />
        : <ul className="divide-y rounded-xl border" aria-label="Privacy requests">{q.data.map((r) => <RequestRow key={r.id} r={r} busy={dl.isPending} onDownload={() => dl.mutate(r)} />)}</ul>}
      {erase && <EraseDialog contactId={contactId.trim()} busy={er.isPending} onConfirm={() => er.mutate()} onClose={() => setErase(false)} />}
    </Card>
  );
}

export default function DataPage() {
  const { isAdmin } = useRole();
  if (!isAdmin) return <><PageHeader title="Data and privacy" /><RoleNotice what="managing data retention and privacy requests" /></>;
  return (
    <Stagger className="max-w-4xl space-y-5">
      <StaggerItem><PageHeader title="Data and privacy" subtitle="Retention policy, exports and erasure requests." /></StaggerItem>
      <StaggerItem><RetentionCard /></StaggerItem>
      <StaggerItem><GdprCard /></StaggerItem>
    </Stagger>
  );
}
