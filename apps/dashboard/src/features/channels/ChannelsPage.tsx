import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Plus, ShieldAlert, Trash2, Users, XCircle } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { motion, Stagger, StaggerItem } from "@/components/motion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { ag, errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, fmtDate, PageHeader, RoleNotice, Select, TextField, useRole } from "../common/ui";
import { CopyField } from "../integrations-ui/CopyField";
import { CHANNEL_META, channelsApi, type AvailableChannel, type ChannelKey, type Connection, type MergeSuggestion } from "./api";
import { ChannelGlyph } from "./glyphs";
import { CHANNEL_STEPS } from "./guides";
import { Skeleton } from "@/components/ui/skeleton";

/** One honest health state per connection: what the owner should do next, not the raw status column. */
type Health = { key: "connected" | "attention" | "error" | "paused" | "untested"; label: string; tone: "success" | "warning" | "destructive" | "secondary" | "info" };
function healthOf(c: Connection): Health {
  if (c.status === "disabled") return { key: "paused", label: "Paused", tone: "secondary" };
  if (c.status === "error") return { key: "error", label: "Error", tone: "destructive" };
  if (c.health?.ok === false) return { key: "attention", label: "Needs attention", tone: "warning" };
  if (c.health?.ok === true) return { key: "connected", label: "Connected", tone: "success" };
  return { key: "untested", label: "Not tested yet", tone: "info" };
}
const dotClass: Record<Health["key"], string> = { connected: "bg-success", attention: "bg-warning", error: "bg-destructive", paused: "bg-muted-foreground/50", untested: "bg-info" };

function HealthDot({ h }: { h: Health }) {
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
      {h.key === "connected" && <span className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />}
      <span className={cn("relative inline-flex size-2.5 rounded-full", dotClass[h.key])} />
    </span>
  );
}

const SECRET_HINT = /verifyToken|webhookSecret/;

function useAgents() {
  const agents = useQuery({ queryKey: ["agents"], queryFn: ag.agents });
  return (agents.data ?? []).filter((a) => a.status === "published");
}

function Steps({ items, start = 1 }: { items: string[]; start?: number }) {
  return (
    <ol className="space-y-2.5">
      {items.map((t, i) => (
        <li key={t} className="flex gap-3 text-sm">
          <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold tabular-nums text-accent-foreground">{start + i}</span>
          <span className="text-muted-foreground">{t}</span>
        </li>
      ))}
    </ol>
  );
}

type Created = Connection & { generatedSecrets?: Record<string, string> };

/** Sheet with two stages: fill in credentials, then a one-time reveal of the webhook values with a connection test. */
function ConnectSheet({ spec, onClose }: { spec: AvailableChannel; onClose: () => void }) {
  const qc = useQueryClient();
  const meta = CHANNEL_META[spec.channel];
  const steps = CHANNEL_STEPS[spec.channel];
  const agents = useAgents();
  const [name, setName] = useState(meta.label);
  const [agentId, setAgentId] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Created | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fields = spec.credentialFields;
  const m = useMutation({
    mutationFn: () => channelsApi.create({
      channel: spec.channel, name: name.trim(), ...(agentId ? { agentId } : {}),
      credentials: Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()])),
    }),
    onSuccess: (c) => { setCreated(c); void qc.invalidateQueries({ queryKey: ["channels"] }); toast.success(`${c.name} connected`); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const test = useMutation({
    mutationFn: () => channelsApi.test(created!.id),
    onSuccess: (r) => { setResult({ ok: r.ok, text: r.detail }); void qc.invalidateQueries({ queryKey: ["channels"] }); (r.ok ? toast.success : toast.error)(r.ok ? "Connection OK" : "Test failed"); },
    onError: (e) => { setResult({ ok: false, text: errMsg(e) }); toast.error("Test failed"); },
  });
  const missing = fields.some((f) => f.required && !creds[f.name]?.trim() && !SECRET_HINT.test(f.name));
  const secrets: Record<string, string> = created ? { "Webhook URL": created.webhookUrl, ...(created.generatedSecrets ?? {}) } : {};

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="flex-row items-center gap-3">
          <ChannelGlyph channel={spec.channel} />
          <div className="min-w-0">
            <SheetTitle>{created ? `${created.name} connected` : `Connect ${meta.label}`}</SheetTitle>
            <SheetDescription>{created ? "One more step in the provider console." : meta.hint}</SheetDescription>
          </div>
        </SheetHeader>
        <div className="flex-1 space-y-5 px-4 pb-6">
          <AnimatePresence mode="wait" initial={false}>
            {!created ? (
              <motion.div key="form" exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.15 }} className="space-y-5">
                <Steps items={steps.before} />
                {steps.note && <Alert variant="info"><ShieldAlert /><AlertTitle>Before you go live</AlertTitle><AlertDescription>{steps.note}</AlertDescription></Alert>}
                <Separator />
                <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !missing) m.mutate(); }}>
                  {m.isError && <Alert variant="destructive"><AlertTriangle /><AlertDescription>{errMsg(m.error)}</AlertDescription></Alert>}
                  <TextField label="Connection name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
                  <Select label="Answering agent" hint="Leave empty to use the default published agent." value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">Default agent</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                  {fields.map((f) => (
                    <TextField key={f.name} label={`${f.label}${f.required ? "" : " (optional)"}`} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
                      value={creds[f.name] ?? ""} onChange={(e) => setCreds({ ...creds, [f.name]: e.target.value })}
                      hint={SECRET_HINT.test(f.name) ? "Leave empty and we generate one for you." : undefined} />
                  ))}
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button type="submit" disabled={m.isPending || missing || !name.trim()}>{m.isPending && <Loader2 className="animate-spin" />}Connect</Button>
                  </div>
                </form>
              </motion.div>
            ) : (
              <motion.div key="done" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }} className="space-y-5">
                <Alert variant="warning"><KeyRound /><AlertTitle>Shown only once</AlertTitle><AlertDescription>Copy these now and paste them into the provider console. After you close this panel the secrets stay masked.</AlertDescription></Alert>
                <dl className="space-y-3">
                  {(Object.entries(secrets) as Array<[string, string]>).map(([k, v]) => (
                    <div key={k}><dt className="mb-1 text-sm font-medium">{k}</dt><dd><CopyField label={k} value={v} testId={`secret-${k}`} wrap /></dd></div>
                  ))}
                </dl>
                <Steps items={steps.after} />
                <div className="rounded-xl border bg-muted/40 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending && <Loader2 className="animate-spin" />}Test connection</Button>
                    <p role="status" aria-live="polite" className="min-w-0 flex-1 text-sm">
                      {result ? (
                        <span className={cn("inline-flex items-start gap-1.5", result.ok ? "text-success" : "text-destructive")}>
                          {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}<span>{result.ok ? "Connection OK. " : "Test failed. "}{result.text}</span>
                        </span>
                      ) : <span className="text-muted-foreground">Checks that the credentials are accepted.</span>}
                    </p>
                  </div>
                </div>
                <Button className="w-full" onClick={onClose}>I have saved these</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ManageSheet({ conn, spec, onClose }: { conn: Connection; spec?: AvailableChannel; onClose: () => void }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const [name, setName] = useState(conn.name);
  const [agentId, setAgentId] = useState(conn.agentId ?? "");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const filled = Object.entries(creds).filter(([, v]) => v.trim());
  const m = useMutation({
    mutationFn: () => channelsApi.update(conn.id, { name: name.trim(), agentId: agentId || null, ...(filled.length ? { credentials: Object.fromEntries(filled.map(([k, v]) => [k, v.trim()])) } : {}) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["channels"] }); toast.success(`${name.trim()} saved`); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="flex-row items-center gap-3">
          <ChannelGlyph channel={conn.channel} />
          <div className="min-w-0"><SheetTitle>Edit {conn.name}</SheetTitle><SheetDescription>{CHANNEL_META[conn.channel].label}</SheetDescription></div>
        </SheetHeader>
        <form className="flex-1 space-y-5 px-4 pb-6" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          {m.isError && <Alert variant="destructive"><AlertTriangle /><AlertDescription>{errMsg(m.error)}</AlertDescription></Alert>}
          <TextField label="Connection name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          <Select label="Answering agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Default agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <fieldset className="space-y-3 rounded-xl border p-4">
            <legend className="px-1 text-sm font-medium">Rotate credentials</legend>
            <p className="text-sm text-muted-foreground">Only fields you fill in are replaced. Current values are masked and never leave the server.</p>
            {(spec?.credentialFields ?? []).map((f) => (
              <TextField key={f.name} label={f.label} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
                placeholder={conn.credentialsMasked[f.name] ?? ""} value={creds[f.name] ?? ""} onChange={(e) => setCreds({ ...creds, [f.name]: e.target.value })} />
            ))}
          </fieldset>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Save</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function ConnectionTile({ c, spec, canEdit }: { c: Connection; spec?: AvailableChannel; canEdit: boolean }) {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["channels"] });
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => channelsApi.test(c.id),
    onSuccess: (r) => { setMsg({ ok: r.ok, text: r.detail }); inv(); (r.ok ? toast.success : toast.error)(r.ok ? `${c.name}: connection OK` : `${c.name}: test failed`); },
    onError: (e) => { setMsg({ ok: false, text: errMsg(e) }); toast.error(`${c.name}: test failed`); },
  });
  const toggle = useMutation({
    mutationFn: () => channelsApi.update(c.id, { status: c.status === "disabled" ? "active" : "disabled" }),
    onSuccess: () => { inv(); toast.success(c.status === "disabled" ? `${c.name} enabled` : `${c.name} disabled`); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rm = useMutation({ mutationFn: () => channelsApi.remove(c.id), onSuccess: () => { setDel(false); inv(); toast.success(`${c.name} deleted`); }, onError: (e) => toast.error(errMsg(e)) });
  const meta = CHANNEL_META[c.channel];
  const h = healthOf(c);
  return (
    <Card className="gap-4">
      <div className="flex items-start gap-3">
        <ChannelGlyph channel={c.channel} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-base font-semibold">{c.name}</h3>
          <p className="text-sm text-muted-foreground">{meta.label}</p>
        </div>
        <Badge variant={h.tone} className="shrink-0 gap-1.5"><HealthDot h={h} />{h.label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {c.health?.checkedAt ? <>Last check {fmtDate(c.health.checkedAt)}{c.health.ok ? ", healthy" : <>: <span className="text-destructive">{c.health.error ?? "failing"}</span></>}</> : "Never tested"}
      </p>
      {Object.keys(c.credentialsMasked).length > 0 && (
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {Object.entries(c.credentialsMasked).map(([k, v]) => <div key={k} className="flex min-w-0 gap-2"><dt className="shrink-0 text-muted-foreground">{k}</dt><dd className="truncate font-mono text-xs leading-5">{v}</dd></div>)}
        </dl>
      )}
      <div>
        <p className="mb-1 text-sm text-muted-foreground">Webhook URL</p>
        <CopyField label={`webhook URL for ${c.name}`} value={c.webhookUrl} />
      </div>
      <p role="status" aria-live="polite" className={cn("min-h-0 text-sm", msg ? (msg.ok ? "text-success" : "text-destructive") : "sr-only")}>
        {msg && <>{msg.ok ? "Connection OK. " : "Test failed. "}{msg.text}</>}
      </p>
      {canEdit && (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending && <Loader2 className="animate-spin" />}Test connection<span className="sr-only"> {c.name}</span></Button>
          <Button variant="ghost" size="sm" onClick={() => setEdit(true)}>Edit<span className="sr-only"> {c.name}</span></Button>
          <Button variant="ghost" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>{c.status === "disabled" ? "Enable" : "Disable"}<span className="sr-only"> {c.name}</span></Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive sm:ml-auto" onClick={() => setDel(true)}><Trash2 />Delete<span className="sr-only"> {c.name}</span></Button>
        </div>
      )}
      {edit && <ManageSheet conn={c} spec={spec} onClose={() => setEdit(false)} />}
      {del && <ConfirmModal danger title="Delete connection?" body={<>Conversations keep their history, but replies on "{c.name}" can no longer be sent.</>} confirm="Delete" busy={rm.isPending} onConfirm={() => rm.mutate()} onClose={() => setDel(false)} />}
    </Card>
  );
}

const reasonText = { same_email: "same email", same_phone: "same phone", same_name: "same name" } as const;
function Person({ p }: { p: MergeSuggestion["primary"] }) {
  return <span className="min-w-0"><span className="font-medium">{p.name ?? "Unnamed"}</span> <span className="break-all text-muted-foreground">{p.email ?? p.phone ?? ""}</span></span>;
}

function MergeSuggestions({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["channels", "merge"], queryFn: channelsApi.suggestions });
  const inv = () => void qc.invalidateQueries({ queryKey: ["channels", "merge"] });
  const merge = useMutation({ mutationFn: (s: MergeSuggestion) => channelsApi.merge(s.primary.id, s.other.id), onSuccess: () => { inv(); toast.success("Contacts merged"); }, onError: (e) => toast.error(errMsg(e)) });
  const dismiss = useMutation({ mutationFn: (id: string) => channelsApi.dismiss(id), onSuccess: () => { inv(); toast.success("Suggestion dismissed"); }, onError: (e) => toast.error(errMsg(e)) });
  if (q.isPending || q.isError || q.data.length === 0) return null;
  return (
    <section aria-labelledby="ms" className="mt-10">
      <h2 id="ms" className="flex items-center gap-2 font-display text-lg font-semibold"><Users className="size-5 text-muted-foreground" />Possible duplicate contacts</h2>
      <p className="mb-3 mt-1 text-sm text-muted-foreground">The same person reached you on more than one channel. Merge them into one timeline.</p>
      <Card className="gap-0 p-0">
        <ul className="divide-y">
          <AnimatePresence initial={false}>
            {q.data.map((s) => (
              <motion.li key={s.id} layout exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-3 overflow-hidden p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"><Person p={s.primary} /><span className="text-muted-foreground">and</span><Person p={s.other} /><Badge variant="warning">{reasonText[s.reason]}</Badge></div>
                {canEdit && <div className="flex gap-2"><Button size="sm" disabled={merge.isPending} onClick={() => merge.mutate(s)}>Merge</Button><Button size="sm" variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate(s.id)}>Dismiss</Button></div>}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </Card>
    </section>
  );
}

export default function ChannelsPage() {
  const { isAdmin } = useRole();
  const avail = useQuery({ queryKey: ["channels", "available"], queryFn: channelsApi.available });
  const list = useQuery({ queryKey: ["channels"], queryFn: channelsApi.list });
  const [connect, setConnect] = useState<ChannelKey | null>(null);
  const specs = avail.data ?? [];
  const spec = (k: ChannelKey) => specs.find((s) => s.channel === k);
  const counts = (list.data ?? []).reduce<Record<string, number>>((a, c) => ({ ...a, [c.channel]: (a[c.channel] ?? 0) + 1 }), {});
  return (
    <div>
      <PageHeader title="Channels" subtitle="Bring WhatsApp, Messenger, Instagram, Telegram and Slack conversations into one inbox, answered by your agent." />
      {!isAdmin && <RoleNotice what="connecting or changing channels" />}
      {avail.isError ? <ErrorState error={avail.error} retry={() => void avail.refetch()} /> : (
        <section aria-labelledby="add" className="mb-8">
          <h2 id="add" className="mb-3 font-display text-lg font-semibold">Add a channel</h2>
          <Stagger className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {(Object.keys(CHANNEL_META) as ChannelKey[]).map((k) => (
              <StaggerItem key={k}>
                <button disabled={!isAdmin || !spec(k)} onClick={() => setConnect(k)}
                  className="group flex h-full min-h-28 w-full items-start gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:border-border disabled:hover:shadow-none xl:flex-col">
                  <ChannelGlyph channel={k} className="transition-transform group-hover:scale-105" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">{CHANNEL_META[k].label}{counts[k] ? <Badge variant="secondary" className="font-normal">{counts[k]} connected</Badge> : <Plus className="size-4 text-muted-foreground" aria-hidden="true" />}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">{CHANNEL_META[k].hint}</span>
                  </span>
                </button>
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      )}
      <h2 className="mb-3 font-display text-lg font-semibold">Connected</h2>
      {list.isPending ? (
        <div role="status" className="grid gap-4 lg:grid-cols-2"><span className="sr-only">Loading…</span>{[0, 1].map((i) => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}</div>
      ) : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : list.data.length === 0
        ? <Empty title="No channels connected" body="The website widget works without setup. Pick a messaging channel above to reply from the same inbox." />
        : <div className="grid gap-4 lg:grid-cols-2"><AnimatePresence initial={false}>{list.data.map((c) => (
            <motion.div key={c.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}><ConnectionTile c={c} spec={spec(c.channel)} canEdit={isAdmin} /></motion.div>
          ))}</AnimatePresence></div>}
      <MergeSuggestions canEdit />
      {connect && spec(connect) && <ConnectSheet spec={spec(connect)!} onClose={() => setConnect(null)} />}
    </div>
  );
}
