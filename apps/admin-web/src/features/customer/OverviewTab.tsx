import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Plus, Trash2, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { TenantDetail } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { DefList, Gated, Section, bucketLabel } from "@/components/bits";
import { Meter } from "@/components/charts";
import { Loading, Spinner, TextArea } from "@/components/common";
import { ago, fmtDate, fmtNum, titleCase } from "@/lib/format";
import { errMsg } from "@/lib/errors";

function Notes({ id }: { id: string }) {
  const { admin, can } = useAuth();
  const q = useQuery({ queryKey: keys.notes(id), queryFn: () => adminApi.notes(id) });
  const [body, setBody] = useState("");
  const add = useMutation({ mutationFn: () => adminApi.addNote(id, body.trim()), onSuccess: () => { setBody(""); toast.success("Note added"); }, onError: (e) => toast.error(errMsg(e)) });
  const del = useMutation({ mutationFn: (nid: string) => adminApi.deleteNote(id, nid), onError: (e) => toast.error(errMsg(e)) });
  const write = can("notesAndTags");
  return (
    <Section title="Internal notes" hint="Only platform admins see these. Never include customer message content.">
      {write ? (
        <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(); }}>
          <TextArea label="Add a note" value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={2000} placeholder="Context for the next person who opens this customer" />
          <Button size="sm" disabled={add.isPending || !body.trim()}>{add.isPending && <Spinner />}Add note</Button>
        </form>
      ) : <p className="mb-3 text-sm text-muted-foreground">{whoCan("notesAndTags")} to add notes.</p>}
      {q.isPending ? <Loading rows={1} /> : (q.data?.items.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
        <ul className="divide-y">
          {q.data!.items.map((n) => (
            <li key={n.id} className="flex items-start gap-3 py-3 first:pt-0">
              <div className="min-w-0 flex-1"><p className="whitespace-pre-wrap break-words text-sm">{n.body}</p><p className="mt-1 text-xs text-muted-foreground">{n.adminEmail} · {fmtDate(n.createdAt)}</p></div>
              {write && (can("tenantLifecycle") || n.adminId === admin?.id) && <Button variant="ghost" size="icon-sm" aria-label="Delete note" onClick={() => del.mutate(n.id)}><Trash2 /></Button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Tags({ id, tags }: { id: string; tags: string[] }) {
  const { can } = useAuth();
  const [v, setV] = useState("");
  const save = useMutation({ mutationFn: (next: string[]) => adminApi.setTags(id, next), onError: (e) => toast.error(errMsg(e)) });
  const write = can("notesAndTags");
  const add = () => { const t = v.trim().toLowerCase(); if (t && !tags.includes(t)) save.mutate([...tags, t], { onSuccess: () => setV("") }); };
  return (
    <Section title="Tags" hint="Free labels for filtering the customer list.">
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && <span className="text-sm text-muted-foreground">No tags.</span>}
        {tags.map((t) => <Badge key={t} variant="outline" className="gap-1 font-mono">{t}{write && <button type="button" aria-label={`Remove tag ${t}`} onClick={() => save.mutate(tags.filter((x) => x !== t))} className="rounded-full hover:text-destructive"><X className="size-3" /></button>}</Badge>)}
      </div>
      {write ? (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="vip" aria-label="New tag" className="font-mono" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,29}" maxLength={30} />
          <Button variant="outline" disabled={save.isPending || !v.trim()}><Plus aria-hidden />Add</Button>
        </form>
      ) : <p className="mt-3 text-sm text-muted-foreground">{whoCan("notesAndTags")} to edit tags.</p>}
    </Section>
  );
}

export default function OverviewTab({ id, d, onTab }: { id: string; d: TenantDetail; onTab: (t: string) => void }) {
  const c = d.counts;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Section title="Health" hint={`${bucketLabel[d.health.bucket]}, score ${d.health.score} of 100`}>
          {d.health.reasons.length === 0 ? <p className="text-sm text-muted-foreground">No problems detected in the last 7 days.</p> : (
            <ul className="space-y-2.5">
              {d.health.reasons.map((r) => (
                <li key={r.code} className="flex items-start gap-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">{r.label}</span>
                  <span className="shrink-0 rounded-md bg-muted px-1.5 font-mono text-xs tabular-nums text-muted-foreground" title="Points removed from the score">-{r.points}</span>
                </li>
              ))}
            </ul>
          )}
          {d.errorCount7d > 0 && <Button variant="outline" size="sm" className="mt-4" onClick={() => onTab("issues")}>See the {d.errorCount7d} errors<ArrowRight aria-hidden /></Button>}
        </Section>
        <Section title="Key facts">
          <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            <DefList rows={[
              ["Owner", d.owner ? <>{d.owner.name}<span className="block text-muted-foreground">{d.owner.email}</span></> : "None"],
              ["Created", fmtDate(d.tenant.createdAt)],
              ["Last activity", <span title={fmtDate(d.lastActivityAt)}>{ago(d.lastActivityAt)}</span>],
              ["Plan", titleCase(d.tenant.plan)],
              ["Errors, 7 days", d.errorCount7d],
            ]} />
            <DefList rows={[
              ["Team members", fmtNum(c.users)], ["Agents", fmtNum(c.agents)], ["Widgets", fmtNum(c.widgets)], ["Channels", fmtNum(c.channels)],
              ["Knowledge sources", fmtNum(c.knowledgeSources)], ["Contacts", fmtNum(c.contacts)], ["Conversations", fmtNum(c.conversations)],
            ]} />
          </div>
        </Section>
        {d.limits.length > 0 && (
          <Section title="Plan limits" hint="Usage against what the plan includes">
            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">{d.limits.map((l) => <div key={l.metric}><p className="mb-1 text-sm text-muted-foreground">{titleCase(l.metric)}</p><Meter used={l.used} limit={l.limit} warning={l.warning} /></div>)}</div>
          </Section>
        )}
        <Notes id={id} />
      </div>
      <div className="space-y-4">
        <Tags id={id} tags={d.tags} />
        <Section title="Quick actions">
          <div className="grid gap-2">
            <Button variant="outline" className="justify-between" onClick={() => onTab("issues")}>Review issues<ArrowRight aria-hidden /></Button>
            <Button variant="outline" className="justify-between" onClick={() => onTab("team")}>See the team<ArrowRight aria-hidden /></Button>
            <Button variant="outline" className="justify-between" onClick={() => onTab("usage")}>Usage and credits<ArrowRight aria-hidden /></Button>
          </div>
        </Section>
        {d.credits.status !== "ok" && !d.credits.unlimited && <Alert variant={d.credits.status === "exhausted" ? "destructive" : "warning"}><div><p className="font-semibold">{d.credits.status === "exhausted" ? "Credits used up" : "Credits running low"}</p><p className="text-muted-foreground">{Math.round(d.credits.percentUsed)}% of the allowance is used.</p></div></Alert>}
      </div>
    </div>
  );
}
