import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowDownLeft, ArrowUpRight, Copy, Download, KeyRound, Plus, RotateCw, Search, Trash2, Webhook } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, fmtDate, Loading, Modal, PageHeader, RoleNotice, Select, Stat, TextArea, TextField, useRole } from "../common/ui";
import { FilterPanel } from "../ops-settings/FilterPanel";
import { useIsDesktop } from "../ops-settings/hooks";
import { downloadCsv, label, money, ops, qs, TXN_STATUSES, type Transaction, type TxnFilters, type TxnStatus, type WebhookEndpoint } from "../ops-settings/opsApi";

const TONE: Record<TxnStatus, "success" | "warning" | "destructive" | "secondary"> = { completed: "success", pending: "warning", failed: "destructive", refunded: "secondary" };
const Amount = ({ t, className }: { t: Transaction; className?: string }) => <span className={cn("tabular-nums", t.amountCents < 0 && "text-destructive", className)}>{money(t.amountCents, t.currency)}</span>;

export default function TransactionsPage() {
  const { atLeast, isAdmin, role } = useRole();
  const desktop = useIsDesktop();
  const qc = useQueryClient();
  const [f, setF] = useState<TxnFilters>({});
  const [open, setOpen] = useState<Transaction | null>(null);
  const [creating, setCreating] = useState(false);
  const [hooks, setHooks] = useState(false);
  const allowed = atLeast("agent");
  const q = useInfiniteQuery({ queryKey: ["txns", f], queryFn: ({ pageParam }) => ops.txns(f, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined, enabled: allowed });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const summary = q.data?.pages[0]?.summary;
  const exp = useMutation({
    mutationFn: async () => {
      const id = toast.loading("Exporting transactions…", { description: "Preparing your CSV file" });
      try { await downloadCsv(`/transactions/export.csv${qs({ ...f })}`, "transactions.csv"); toast.success("Exported transactions.csv", { id, description: "Check your downloads folder." }); }
      catch (e) { toast.error("Could not export", { id, description: errMsg(e) }); throw e; }
    },
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["txns"] });
  if (!allowed) return <><PageHeader title="Transactions" /><RoleNotice what="viewing transactions (agent role or higher)" /><p className="text-muted-foreground">Current role: {role}.</p></>;
  const active = [f.status, f.source, f.from, f.to].filter(Boolean).length;
  const sums = Array.isArray(summary?.byCurrency) ? summary.byCurrency.map((x) => money(x.totalCents, x.currency)) : summary?.byCurrency ? Object.entries(summary.byCurrency).map(([c, v]) => money(v, c)) : [];
  const totalText = sums.length > 0 ? sums.join(" + ") : summary ? money(summary.totalCents ?? 0, "USD") : "";

  return (
    <div>
      <PageHeader title="Transactions" subtitle="Payments and orders linked to your contacts, entered manually or ingested by signed webhooks."
        actions={<>
          {isAdmin && <Button variant="outline" onClick={() => setHooks(true)}><Webhook />Webhook endpoints</Button>}
          <Button variant="outline" disabled={exp.isPending} onClick={() => exp.mutate()}><Download />{exp.isPending ? "Exporting…" : "Export CSV"}</Button>
          <Button onClick={() => setCreating(true)}><Plus />Add transaction</Button>
        </>} />
      {summary && (
        <div className="mb-5 grid grid-cols-2 gap-3" aria-label="Summary">
          <Stat label="Matching transactions" value={summary.count} />
          <Card className="gap-1.5"><p className="text-sm text-muted-foreground">Completed total</p><p className="font-display text-xl font-semibold tabular-nums tracking-tight sm:text-3xl">{totalText}</p></Card>
        </div>)}
      <form role="search" aria-label="Filter transactions" className="mb-5 flex gap-2" onSubmit={(e) => e.preventDefault()}>
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Label htmlFor="xq" className="sr-only">Search</Label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="xq" type="search" className="pl-9" placeholder="Search description or external ID" value={f.q ?? ""} onChange={(e) => setF({ ...f, q: e.target.value || undefined })} />
        </div>
        <FilterPanel active={active} onClear={() => setF({ q: f.q })}>
          <Select label="Status" value={f.status ?? ""} onChange={(e) => setF({ ...f, status: e.target.value || undefined })}><option value="">Any</option>{TXN_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
          <Select label="Source" value={f.source ?? ""} onChange={(e) => setF({ ...f, source: e.target.value || undefined })}><option value="">Any</option><option value="manual">Manual</option><option value="webhook">Webhook</option></Select>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="From" type="date" value={f.from?.slice(0, 10) ?? ""} onChange={(e) => setF({ ...f, from: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
            <TextField label="To" type="date" value={f.to?.slice(0, 10) ?? ""} onChange={(e) => setF({ ...f, to: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : undefined })} />
          </div>
        </FilterPanel>
      </form>
      {q.isPending ? <Loading label="Loading transactions" rows={5} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : rows.length === 0 ? (
        <Empty title="No transactions" body="Add one manually or connect a webhook endpoint to ingest payments automatically." action={<Button onClick={() => setCreating(true)}><Plus />Add transaction</Button>} />
      ) : (
        <>
          {desktop ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <caption className="sr-only">Transactions</caption>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead scope="col">Date</TableHead><TableHead scope="col">Description</TableHead><TableHead scope="col">Contact</TableHead><TableHead scope="col">Source</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col" className="text-right">Amount</TableHead></TableRow></TableHeader>
                <TableBody>{rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(t.occurredAt)}</TableCell>
                    <TableCell className="max-w-80"><button className="block max-w-full truncate text-left font-medium hover:underline" onClick={() => setOpen(t)}>{t.description || t.externalId || "Transaction"}</button></TableCell>
                    <TableCell>{t.contactName ?? <span className="text-muted-foreground">-</span>}</TableCell><TableCell className="capitalize">{t.source}</TableCell>
                    <TableCell><Badge variant={TONE[t.status]}>{label(t.status)}</Badge></TableCell>
                    <TableCell className="text-right font-medium"><Amount t={t} /></TableCell>
                  </TableRow>))}</TableBody>
              </Table>
            </div>
          ) : (
            <ul className="space-y-2.5" aria-label="Transactions">{rows.map((t) => (
              <li key={t.id}>
                <button onClick={() => setOpen(t)} className="flex w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-left outline-none transition-colors active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/30">
                  <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", t.amountCents < 0 ? "bg-destructive/12 text-destructive" : "bg-success/12 text-success")}>{t.amountCents < 0 ? <ArrowDownLeft className="size-5" /> : <ArrowUpRight className="size-5" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.description || t.externalId || "Transaction"}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.contactName ? `${t.contactName} · ` : ""}{fmtDate(t.occurredAt)}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1"><Amount t={t} className="font-semibold" /><Badge variant={TONE[t.status]}>{label(t.status)}</Badge></span>
                </button>
              </li>))}</ul>
          )}
          {q.hasNextPage && <div className="mt-4 text-center"><Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>}
        </>)}
      {open && <TxnDetail t={open} onClose={() => setOpen(null)} onChanged={refresh} />}
      {creating && <NewTxn onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
      {hooks && <Endpoints onClose={() => setHooks(false)} />}
    </div>
  );
}

function TxnDetail({ t, onClose, onChanged }: { t: Transaction; onClose: () => void; onChanged: () => void }) {
  const { isAdmin } = useRole();
  const [status, setStatus] = useState<TxnStatus>(t.status);
  const [desc, setDesc] = useState(t.description ?? "");
  const [del, setDel] = useState(false);
  const save = useMutation({ mutationFn: () => ops.patchTxn(t.id, { status, description: desc || null }), onSuccess: () => { toast.success("Transaction saved"); onChanged(); onClose(); }, onError: (e) => toast.error("Could not save transaction", { description: errMsg(e) }) });
  const rm = useMutation({ mutationFn: () => ops.deleteTxn(t.id), onSuccess: () => { toast.success("Transaction deleted"); onChanged(); onClose(); }, onError: (e) => toast.error("Could not delete transaction", { description: errMsg(e) }) });
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full max-w-none sm:max-w-md" side="right">
        <SheetHeader><SheetTitle>Transaction</SheetTitle><SheetDescription className="sr-only">Transaction details</SheetDescription></SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          <div>
            <p className="font-display text-4xl font-semibold tracking-tight"><Amount t={t} /></p>
            <Badge className="mt-2" variant={TONE[t.status]}>{label(t.status)}</Badge>
          </div>
          <dl className="grid grid-cols-[7rem_1fr] gap-y-2 rounded-xl bg-muted/60 p-3 text-sm">
            <dt className="text-muted-foreground">Date</dt><dd>{fmtDate(t.occurredAt)}</dd>
            <dt className="text-muted-foreground">Source</dt><dd className="capitalize">{t.source}</dd>
            <dt className="text-muted-foreground">External ID</dt><dd className="break-all font-mono text-xs leading-5">{t.externalId ?? "-"}</dd>
            <dt className="text-muted-foreground">Contact</dt><dd>{t.contactName ?? "-"}</dd>
          </dl>
          {Object.keys(t.metadata ?? {}).length > 0 && <pre className="max-h-40 overflow-auto rounded-xl bg-muted p-3 font-mono text-xs">{JSON.stringify(t.metadata, null, 2)}</pre>}
          <div className="space-y-3">
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as TxnStatus)}>{TXN_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
            <TextField label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t p-3">
          {isAdmin ? <Button variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => setDel(true)}><Trash2 />Delete</Button> : <span />}
          <div className="flex gap-2"><Button variant="outline" onClick={onClose}>Close</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
        </div>
        {del && <ConfirmModal title="Delete transaction" danger confirm="Delete" busy={rm.isPending} body="This cannot be undone." onConfirm={() => rm.mutate()} onClose={() => setDel(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function NewTxn({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ amount: "", currency: "USD", status: "completed" as TxnStatus, description: "", externalId: "" });
  const cents = Math.round(parseFloat(f.amount) * 100);
  const valid = Number.isFinite(cents) && /^[A-Za-z]{3}$/.test(f.currency);
  const m = useMutation({
    mutationFn: () => ops.createTxn({ amountCents: cents, currency: f.currency.toUpperCase(), status: f.status, ...(f.description ? { description: f.description } : {}), ...(f.externalId ? { externalId: f.externalId } : {}) }),
    onSuccess: () => { toast.success("Transaction added"); onCreated(); },
    onError: (e) => toast.error("Could not add transaction", { description: errMsg(e) }),
  });
  return (
    <Modal title="Add transaction" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }}>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2"><TextField label="Amount" inputMode="decimal" required hint="Negative for refunds" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <TextField label="Currency" maxLength={3} required value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
        </div>
        <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as TxnStatus })}>{TXN_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        <TextArea label="Description" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <TextField label="External ID (optional)" value={f.externalId} onChange={(e) => setF({ ...f, externalId: e.target.value })} />
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!valid || m.isPending}>Add</Button></div>
      </form>
    </Modal>
  );
}

function Endpoints({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["txn-endpoints"], queryFn: ops.endpoints });
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ name: string; url?: string; secret: string } | null>(null);
  const [rm, setRm] = useState<WebhookEndpoint | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ["txn-endpoints"] });
  const fail = (what: string) => (e: unknown) => toast.error(what, { description: errMsg(e) });
  const create = useMutation({ mutationFn: () => ops.createEndpoint(name.trim()), onSuccess: (e) => { setName(""); toast.success("Endpoint created"); setSecret({ name: e.name, url: e.url, secret: e.secret ?? "" }); done(); }, onError: fail("Could not create endpoint") });
  const rotate = useMutation({ mutationFn: (e: WebhookEndpoint) => ops.rotateEndpoint(e.id).then((r) => ({ e, r })), onSuccess: ({ e, r }) => { toast.success("Secret rotated"); setSecret({ name: e.name, url: e.url, secret: r.secret }); }, onError: fail("Could not rotate secret") });
  const toggle = useMutation({ mutationFn: (e: WebhookEndpoint) => ops.patchEndpoint(e.id, { enabled: !e.enabled }).then(() => e), onSuccess: (e) => { toast.success(e.enabled === false ? "Endpoint enabled" : "Endpoint disabled"); done(); }, onError: fail("Could not update endpoint") });
  const del = useMutation({ mutationFn: (e: WebhookEndpoint) => ops.deleteEndpoint(e.id), onSuccess: () => { setRm(null); toast.success("Endpoint deleted"); done(); }, onError: fail("Could not delete endpoint") });
  return (
    <Modal title="Inbound webhook endpoints" onClose={onClose} wide>
      <p className="text-sm text-muted-foreground">POST signed JSON to the endpoint URL. Sign <code className="font-mono text-xs">{"<timestamp>.<body>"}</code> with HMAC-SHA256 and send <code className="font-mono text-xs">X-Yulona-Timestamp</code> and <code className="font-mono text-xs">X-Yulona-Signature: sha256=&lt;hex&gt;</code>.</p>
      {secret && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} role="status" className="mt-4 rounded-xl border border-success/40 bg-success/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" />Signing secret for {secret.name} (shown once, copy it now)</p>
          <code className="mt-2 block break-all rounded-lg bg-card p-2 font-mono text-xs">{secret.secret}</code>
          <div className="mt-2 flex gap-2"><Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(secret.secret); toast.success("Secret copied"); }}><Copy />Copy secret</Button><Button variant="ghost" size="sm" onClick={() => setSecret(null)}>I saved it</Button></div>
        </motion.div>)}
      <form className="mt-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <div className="flex-1"><TextField label="New endpoint name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></div>
        <Button disabled={!name.trim() || create.isPending}>Create</Button>
      </form>
      <div className="mt-4">
        {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 ? <Empty icon={<Webhook className="size-6" />} title="No endpoints" body="Create one to start receiving transactions." /> : (
          <ul className="space-y-2">{q.data.map((e) => (
            <li key={e.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0"><p className="flex items-center gap-2 font-medium">{e.name} <Badge variant={e.enabled === false ? "secondary" : "success"}>{e.enabled === false ? "Disabled" : "Enabled"}</Badge></p><p className="truncate font-mono text-xs text-muted-foreground">{e.url}</p></div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => rotate.mutate(e)}><RotateCw />Rotate secret</Button>
                  <Switch aria-label={`${e.name} enabled`} checked={e.enabled !== false} onCheckedChange={() => toggle.mutate(e)} />
                  <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label={`Delete ${e.name}`} onClick={() => setRm(e)}><Trash2 /></Button>
                </div>
              </div>
            </li>))}</ul>)}
      </div>
      {rm && <ConfirmModal title="Delete endpoint" danger confirm="Delete" busy={del.isPending} body={`Senders using "${rm.name}" will start getting 401 errors.`} onConfirm={() => del.mutate(rm)} onClose={() => setRm(null)} />}
    </Modal>
  );
}
