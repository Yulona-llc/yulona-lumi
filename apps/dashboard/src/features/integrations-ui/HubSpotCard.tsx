import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2Off, Send, TriangleAlert, Workflow } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { Check, ConfirmModal, ErrorState, fmtDate, TextField } from "../common/ui";
import { ops, type HubSpotMapping } from "../ops-settings/opsApi";

const PROPS: { key: keyof HubSpotMapping["properties"]; label: string; hint: string }[] = [
  { key: "need", label: "Need", hint: "What the customer is looking for" },
  { key: "budget", label: "Budget", hint: "Budget the customer mentioned" },
  { key: "timeline", label: "Timeline", hint: "When they want to start" },
  { key: "score", label: "Lead score", hint: "Number property" },
  { key: "conversationLink", label: "Conversation link", hint: "Link back to the conversation" },
  { key: "source", label: "Source", hint: "Filled with the source value below" },
];
const PROP_RE = /^[a-z][a-z0-9_]{0,99}$/;

/** HubSpot CRM card for Settings > Integrations: connect with a private-app token, property mapping, status, last syncs, test contact. */
export default function HubSpotCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hubspot"], queryFn: ops.hubspot });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["hubspot"] });
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [map, setMap] = useState<HubSpotMapping | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [email, setEmail] = useState("");
  useEffect(() => { if (q.data) setMap(q.data.mapping); }, [q.data]);

  const connect = useMutation({
    mutationFn: () => ops.connectHubspot(token.trim(), map ?? undefined),
    onSuccess: () => { setToken(""); setTokenError(null); toast.success("HubSpot connected"); refresh(); },
    onError: (e) => { setTokenError(errMsg(e)); },
  });
  const save = useMutation({ mutationFn: (m: HubSpotMapping) => ops.saveHubspotMapping(m), onSuccess: () => { toast.success("Mapping saved"); refresh(); }, onError: (e) => toast.error("Could not save the mapping", { description: errMsg(e) }) });
  const disconnect = useMutation({ mutationFn: ops.disconnectHubspot, onSuccess: () => { setConfirm(false); toast.success("HubSpot disconnected"); refresh(); }, onError: (e) => toast.error("Could not disconnect", { description: errMsg(e) }) });
  const test = useMutation({
    mutationFn: () => ops.hubspotTestContact(email.trim()),
    onSuccess: (r) => { toast.success(r.action === "created" ? "Test contact created in HubSpot" : "Test contact updated in HubSpot"); refresh(); },
    onError: (e) => { toast.error("HubSpot test failed", { description: errMsg(e) }); refresh(); },
  });

  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const s = q.data;
  const ok = s.connected && s.status !== "error";
  const bad = s.connected && s.status === "error";
  const m = map ?? s.mapping;
  const badProp = PROPS.some((p) => m.properties[p.key] && !PROP_RE.test(m.properties[p.key]!));
  const setProp = (k: keyof HubSpotMapping["properties"], v: string) => setMap({ ...m, properties: { ...m.properties, [k]: v.trim() || undefined } });
  const dirty = JSON.stringify(m) !== JSON.stringify(s.mapping);

  return (
    <Card className={cn("gap-4", ok && "border-success/35", bad && "border-destructive/40")} aria-label="HubSpot">
      <div className="flex items-start gap-3">
        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", ok ? "bg-success/12 text-success" : bad ? "bg-destructive/12 text-destructive" : "bg-muted text-muted-foreground")}>
          {bad ? <TriangleAlert className="size-5" /> : ok ? <CheckCircle2 className="size-5" /> : <Workflow className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg font-semibold">HubSpot</h2>
            {ok ? <Badge variant="success"><span className="size-1.5 rounded-full bg-success" aria-hidden="true" />Connected</Badge> : bad ? <Badge variant="destructive">Needs attention</Badge> : <Badge variant="secondary">Not connected</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">When a lead is qualified (and when they book), Lumi creates or updates the matching HubSpot contact by email.</p>
        </div>
      </div>
      {!s.configured && <p role="alert" className="text-sm text-destructive">This server has no ENCRYPTION_KEY, so HubSpot cannot be connected.</p>}
      {bad && <p role="alert" className="rounded-lg bg-destructive/12 px-3 py-2 text-sm text-destructive">{s.lastError ?? "The connection stopped working."}</p>}
      {ok && s.lastError && <p role="status" className="rounded-lg bg-warning/12 px-3 py-2 text-sm">Last sync problem: {s.lastError}</p>}

      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (token.trim()) connect.mutate(); }}>
        <TextField label={s.connected ? "Replace private app token" : "Private app access token"} type="password" autoComplete="off" value={token} onChange={(e) => { setToken(e.target.value); setTokenError(null); }}
          placeholder={s.connected ? "Token saved. Paste a new one to replace it." : "pat-..."} error={tokenError ?? undefined}
          hint="Create a private app in HubSpot with the crm.objects.contacts.read and crm.objects.contacts.write scopes. The token is stored encrypted and never shown again." />
        <Button disabled={!token.trim() || connect.isPending || !s.configured}>{connect.isPending ? "Checking…" : s.connected ? "Replace token" : "Connect HubSpot"}</Button>
      </form>

      {s.connected && (
        <>
          <dl className="grid gap-3 rounded-xl bg-muted/60 p-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Connected since</dt><dd className="font-medium">{fmtDate(s.connectedAt)}</dd></div>
            <div><dt className="text-muted-foreground">Last sync</dt><dd className="font-medium">{fmtDate(s.lastSyncAt)}</dd></div>
          </dl>
          <fieldset className="space-y-3">
            <legend className="font-display text-base font-semibold">Property mapping</legend>
            <p className="text-sm text-muted-foreground">Email, name and phone are always sent. Enter the HubSpot internal property name to also send a field; leave it empty to skip it.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {PROPS.map((p) => (
                <TextField key={p.key} label={p.label} hint={p.hint} value={m.properties[p.key] ?? ""} placeholder="e.g. lead_need" onChange={(e) => setProp(p.key, e.target.value)}
                  error={m.properties[p.key] && !PROP_RE.test(m.properties[p.key]!) ? "Use lower-case letters, digits and underscores" : undefined} />))}
              <TextField label="Source value" value={m.sourceValue} onChange={(e) => setMap({ ...m, sourceValue: e.target.value })} hint="Written to the Source property" />
            </div>
            <Check label="Also sync when a booking is confirmed" checked={m.syncOnBooked} onChange={(e) => setMap({ ...m, syncOnBooked: e.target.checked })} />
            <Button variant="outline" disabled={!dirty || badProp || !m.sourceValue.trim() || save.isPending} onClick={() => save.mutate(m)}>{save.isPending ? "Saving…" : "Save mapping"}</Button>
          </fieldset>

          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (email.trim()) test.mutate(); }}>
            <div className="min-w-0 flex-1"><TextField label="Send a test contact" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" hint="Creates or updates this contact in HubSpot using the mapping above." /></div>
            <Button variant="outline" disabled={!email.trim() || test.isPending}><Send />{test.isPending ? "Sending…" : "Send test contact"}</Button>
          </form>

          {s.recent.length > 0 && (
            <div className="space-y-1">
              <h3 className="font-display text-base font-semibold">Recent syncs</h3>
              <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                {s.recent.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <Badge variant={r.status === "ok" ? "success" : r.status === "failed" ? "destructive" : "secondary"}>{r.status === "ok" ? (r.action === "created" ? "Created" : "Updated") : r.status === "failed" ? "Failed" : r.status === "skipped" ? "Skipped" : "Pending"}</Badge>
                    <span>{r.trigger === "qualified" ? "Lead qualified" : r.trigger === "booked" ? "Booking confirmed" : "Test contact"}</span>
                    {r.error && <span className="min-w-0 truncate text-muted-foreground" title={r.error}>{r.error}</span>}
                    <span className="ml-auto text-muted-foreground">{fmtDate(r.syncedAt ?? r.createdAt)}</span>
                  </li>))}
              </ul>
            </div>)}

          <div><Button variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => setConfirm(true)}><Link2Off />Disconnect<span className="sr-only"> HubSpot</span></Button></div>
        </>)}
      {confirm && <ConfirmModal title="Disconnect HubSpot" danger confirm="Disconnect" busy={disconnect.isPending} body="The stored token is deleted and new leads are no longer sent to HubSpot. Contacts already in HubSpot are kept." onConfirm={() => disconnect.mutate()} onClose={() => setConfirm(false)} />}
    </Card>
  );
}
