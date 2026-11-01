import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, KeyRound, Loader2, Pencil, Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { motion } from "@/components/motion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, fmtDate, Loading, Modal, PageHeader, RoleNotice, Select, TextField, useRole } from "../common/ui";
import { planLimitFrom, UpgradePrompt } from "../billing/UpgradePrompt";
import { CopyField } from "./CopyField";
import { intApi, type Delivery, type Webhook } from "./api";

const dTone = { succeeded: "success", failed: "destructive", retrying: "warning", pending: "info", cancelled: "secondary" } as const;

/** Events grouped by resource ("message.created" under "message") so long lists stay scannable. */
function EventPicker({ all, events, sel, onChange }: { all: string[]; events: string[]; sel: string[]; onChange: (s: string[]) => void }) {
  const everything = sel.includes("*");
  const groups = events.reduce<Record<string, string[]>>((a, e) => { const g = e.split(".")[0] ?? e; (a[g] ??= []).push(e); return a; }, {});
  void all;
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">Events</legend>
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border bg-muted/40 px-3 sm:min-h-10">
        <Label htmlFor="ev-all" className="flex-1 cursor-pointer">All events</Label>
        <Switch id="ev-all" checked={everything} onCheckedChange={(v) => onChange(v ? ["*"] : [])} />
      </div>
      {!everything && (
        <div className="max-h-64 divide-y overflow-y-auto rounded-xl border">
          {Object.entries(groups).map(([g, evs]) => (
            <div key={g} className="p-3">
              <p className="mb-1 text-sm font-medium capitalize">{g.replace(/_/g, " ")}</p>
              {evs.map((ev) => (
                <div key={ev} className="flex min-h-11 items-center justify-between gap-3 sm:min-h-9">
                  <Label htmlFor={`ev-${ev}`} className="flex-1 cursor-pointer font-mono text-xs">{ev}</Label>
                  <Switch id={`ev-${ev}`} checked={sel.includes(ev)} onCheckedChange={(v) => onChange(v ? [...sel, ev] : sel.filter((y) => y !== ev))} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function HookForm({ hook, onClose, onDone }: { hook?: Webhook; onClose: () => void; onDone: (secret?: string) => void }) {
  const events = useQuery({ queryKey: ["webhook-events"], queryFn: intApi.events });
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "");
  const [sel, setSel] = useState<string[]>(hook?.events ?? ["*"]);
  const m = useMutation({
    mutationFn: () => (hook ? intApi.updateHook(hook.id, { name: name.trim(), url: url.trim(), events: sel }) : intApi.createHook({ name: name.trim(), url: url.trim(), events: sel })),
    onSuccess: (r) => { toast.success(hook ? "Webhook saved" : "Webhook created"); onDone((r as { secret?: string }).secret); },
    onError: (e) => { if (!planLimitFrom(e)) toast.error(errMsg(e)); },
  });
  return (
    <Modal title={hook ? "Edit webhook" : "Add webhook"} description="Lumi sends a signed POST to this address for each selected event." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && url.trim() && sel.length) m.mutate(); }}>
        {m.isError && !planLimitFrom(m.error) && <Alert variant="destructive"><AlertTriangle /><AlertDescription>{errMsg(m.error)}</AlertDescription></Alert>}
        <UpgradePrompt error={m.error} />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        <TextField label="Endpoint URL" type="url" placeholder="https://example.com/hooks/yulona" value={url} onChange={(e) => setUrl(e.target.value)} required hint="HTTPS only in production. Private and local addresses are rejected." />
        <EventPicker all={events.data ?? []} events={(events.data ?? []).filter((x) => x !== "*")} sel={sel} onChange={setSel} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={m.isPending || !name.trim() || !url.trim() || !sel.length}>{m.isPending && <Loader2 className="animate-spin" />}{hook ? "Save" : "Create"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveryDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["delivery", id], queryFn: () => intApi.delivery(id) });
  return (
    <Modal title="Delivery detail" onClose={onClose} wide>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : (
        <div className="space-y-4 text-sm">
          <p className="flex flex-wrap items-center gap-2"><Badge variant={dTone[q.data.status]}>{q.data.status}</Badge><code className="font-mono">{q.data.eventType}</code><span className="text-muted-foreground">event</span><code className="break-all font-mono text-xs">{q.data.eventId}</code></p>
          <div>
            <h3 className="mb-1.5 font-medium">Attempts</h3>
            {q.data.attemptLog.length === 0 ? <p className="text-muted-foreground">No attempts yet.</p> : (
              <ul className="space-y-2">{q.data.attemptLog.map((a) => (
                <li key={a.attempt} className="rounded-lg border p-3">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">Attempt {a.attempt}</span>
                    <Badge variant={a.statusCode && a.statusCode < 300 ? "success" : "destructive"}>{a.statusCode ?? "no response"}</Badge>
                    <span className="text-muted-foreground">{fmtDate(a.at)} · {a.durationMs ?? "?"} ms</span>
                  </p>
                  {a.error && <p className="mt-1 text-destructive">{a.error}</p>}
                  {a.responseSnippet && <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">{a.responseSnippet}</pre>}
                </li>))}
              </ul>)}
          </div>
          <div><h3 className="mb-1.5 font-medium">Payload</h3><pre className="max-h-64 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs">{JSON.stringify(q.data.payload, null, 2)}</pre></div>
        </div>)}
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

function Deliveries({ hook }: { hook: Webhook }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useInfiniteQuery({ queryKey: ["deliveries", hook.id, status], initialPageParam: null as string | null, queryFn: ({ pageParam }) => intApi.deliveries(hook.id, { status, cursor: pageParam }), getNextPageParam: (l) => l.nextCursor });
  const re = useMutation({
    mutationFn: (d: Delivery) => intApi.redeliver(d.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["deliveries", hook.id] }); toast.success("Redelivery queued"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="mt-4 border-t pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-display font-semibold">Delivery log</h3>
        <Select label="" aria-label="Status filter" className="!w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["succeeded", "failed", "retrying", "pending"].map((s) => <option key={s}>{s}</option>)}</Select>
      </div>
      {q.isPending ? <Loading rows={2} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No deliveries yet. Use "Send test" to create one.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:gap-4">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant={dTone[d.status]}>{d.status}</Badge>
                <code className="truncate font-mono text-xs">{d.eventType}</code>
                <span className="text-xs tabular-nums text-muted-foreground">{d.attempts}/{d.maxAttempts} attempts · HTTP {d.responseStatus ?? "-"} · {fmtDate(d.createdAt)}</span>
              </div>
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setOpen(d.id)}>Details</Button>
                <Button variant="outline" size="sm" disabled={re.isPending || !hook.enabled} onClick={() => re.mutate(d)}><RefreshCw />Redeliver</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && <Button variant="outline" className="mt-3" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more</Button>}
      {open && <DeliveryDetailModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function HookCard({ h, onSecret }: { h: Webhook; onSecret: (s: string) => void }) {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["webhooks"] });
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [logs, setLogs] = useState(false);
  const toggle = useMutation({ mutationFn: () => intApi.updateHook(h.id, { enabled: !h.enabled }), onSuccess: () => { inv(); toast.success(h.enabled ? `${h.name} disabled` : `${h.name} enabled`); }, onError: (e) => toast.error(errMsg(e)) });
  const test = useMutation({
    mutationFn: () => intApi.test(h.id),
    onSuccess: () => { toast.success("Test event queued"); setLogs(true); void qc.invalidateQueries({ queryKey: ["deliveries", h.id] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rot = useMutation({ mutationFn: () => intApi.rotate(h.id), onSuccess: (r) => { toast.success("Secret rotated"); onSecret(r.secret); }, onError: (e) => toast.error(errMsg(e)) });
  const rm = useMutation({ mutationFn: () => intApi.deleteHook(h.id), onSuccess: () => { setDel(false); inv(); toast.success(`${h.name} deleted`); }, onError: (e) => toast.error(errMsg(e)) });
  const failing = h.consecutiveFailures > 0;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"><WebhookIcon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display font-semibold">{h.name}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground" title={h.url}>{h.url}</p>
        </div>
        <Badge variant={h.enabled ? "success" : "destructive"}>{h.enabled ? "enabled" : "disabled"}</Badge>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Subscribed events">
        {h.events.map((e) => <Badge key={e} variant="outline" className="font-mono font-normal">{e === "*" ? "all events" : e}</Badge>)}
      </div>
      {h.disabledReason && <Alert variant="destructive"><AlertTriangle /><AlertDescription>Disabled: {h.disabledReason}</AlertDescription></Alert>}
      <p className="text-sm text-muted-foreground">Last success {fmtDate(h.lastSuccessAt)}, last failure {fmtDate(h.lastFailureAt)}{failing ? <span className="text-warning"> ({h.consecutiveFailures} failures in a row)</span> : null}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setLogs((v) => !v)} aria-expanded={logs}>Deliveries<ChevronDown className={cn("transition-transform", logs && "rotate-180")} /></Button>
        <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Loader2 className="animate-spin" /> : <Send />}Send test</Button>
        <Button variant="ghost" size="sm" onClick={() => setEdit(true)}><Pencil />Edit</Button>
        <Button variant="ghost" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>{h.enabled ? "Disable" : "Enable"}</Button>
        <Button variant="ghost" size="sm" disabled={rot.isPending} onClick={() => rot.mutate()}><KeyRound />Rotate secret</Button>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive sm:ml-auto" onClick={() => setDel(true)}><Trash2 />Delete</Button>
      </div>
      <AnimatePresence initial={false}>
        {logs && <motion.div key="logs" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="-mt-4 overflow-hidden"><Deliveries hook={h} /></motion.div>}
      </AnimatePresence>
      {edit && <HookForm hook={h} onClose={() => setEdit(false)} onDone={() => { setEdit(false); inv(); }} />}
      {del && <ConfirmModal danger title="Delete webhook?" body="The endpoint stops receiving events and its delivery log is removed." confirm="Delete" busy={rm.isPending} onConfirm={() => rm.mutate()} onClose={() => setDel(false)} />}
    </Card>
  );
}

export default function WebhooksPage() {
  const { isAdmin } = useRole();
  const q = useQuery({ queryKey: ["webhooks"], queryFn: intApi.hooks, enabled: isAdmin });
  const qc = useQueryClient();
  const [add, setAdd] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  if (!isAdmin) return <><PageHeader title="Webhooks" /><RoleNotice what="managing webhooks" /></>;
  return (
    <div className="max-w-4xl">
      <PageHeader title="Webhooks" subtitle="Send signed events to your own systems. Each request carries an HMAC-SHA256 signature you can verify." actions={<Button onClick={() => setAdd(true)}><Plus />Add webhook</Button>} />
      {q.isPending ? <div role="status" className="space-y-4"><span className="sr-only">Loading…</span><Skeleton className="h-44 w-full rounded-xl" /><Skeleton className="h-44 w-full rounded-xl" /></div>
        : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty icon={<WebhookIcon className="size-6" />} title="No webhooks" body="Add an endpoint to receive conversation, message, booking and ticket events." />
        : <div className="space-y-4">{q.data.map((h) => <HookCard key={h.id} h={h} onSecret={setSecret} />)}</div>}
      {add && <HookForm onClose={() => setAdd(false)} onDone={(s) => { setAdd(false); void qc.invalidateQueries({ queryKey: ["webhooks"] }); if (s) setSecret(s); }} />}
      {secret && (
        <Modal title="Signing secret" onClose={() => setSecret(null)}>
          <Alert variant="warning" className="mb-4"><KeyRound /><AlertTitle>Shown only once</AlertTitle><AlertDescription>Store it now. Use it to verify the <code className="font-mono text-xs">X-Lumi-Signature</code> header.</AlertDescription></Alert>
          <CopyField label="signing secret" value={secret} testId="webhook-secret" wrap />
          <div className="mt-5 flex justify-end"><Button onClick={() => setSecret(null)}>Done</Button></div>
        </Modal>
      )}
    </div>
  );
}
