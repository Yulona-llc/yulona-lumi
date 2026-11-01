import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowUpRight, Mail, Phone, ShieldAlert } from "lucide-react";
import { contactSchema } from "@yulona/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { request } from "../../api/client";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal, TextField, useRole } from "../common/ui";
import { errMsg } from "../common/api";
import { contactsApi } from "../contacts/api";
import type { AiState } from "./api";
import { CHANNEL_LABEL, contactLabel, fullTime, timeAgo } from "./format";
import { ChannelGlyph, ContactAvatar } from "./parts";

export const STAGES = ["visitor", "engaged", "qualified", "booking_offered", "booked", "handoff_requested"];
export const stageLabel = (s: string) => { const t = s.replace(/_/g, " "); return t[0]!.toUpperCase() + t.slice(1); };

export default function ContactPanel({ contactId, conversationId, ai }: { contactId: string; conversationId?: string; ai?: AiState }) {
  const q = useQuery({ queryKey: ["contact", contactId], queryFn: () => request(`/contacts/${contactId}`, { auth: true, schema: contactSchema }) });
  const history = useQuery({ queryKey: ["contact-history", contactId], queryFn: () => contactsApi.timeline(contactId), retry: false });
  const { atLeast, isAdmin } = useRole();
  const qc = useQueryClient();
  const [blocking, setBlocking] = useState(false);
  const [unblocking, setUnblocking] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = () => { for (const k of [["contact", contactId], ["conversations"], ["conversation", conversationId], ["attention"], ["attention-counts"]]) void qc.invalidateQueries({ queryKey: k }); };
  const block = useMutation({
    mutationFn: () => contactsApi.block(contactId, reason.trim() || undefined),
    onSuccess: () => { setBlocking(false); setReason(""); refresh(); toast.success("Contact blocked"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const unblock = useMutation({
    mutationFn: () => contactsApi.unblock(contactId),
    onSuccess: () => { setUnblocking(false); refresh(); toast.success("Contact unblocked"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const idx = ai?.stage ? STAGES.indexOf(ai.stage) : -1;
  const lead = Object.entries(ai?.lead ?? {}).filter(([, v]) => v !== null && v !== "" && v !== undefined);
  const channels = [...new Set(q.data?.identities.map((i) => i.channel) ?? [])];
  const attrs = Object.entries(q.data?.customAttributes ?? {});
  const earlier = (history.data?.items ?? []).filter((i) => i.type === "conversation_started" && i.conversationId !== conversationId).slice(0, 4);

  return (
    <aside aria-label="Contact details" className="space-y-6 p-4">
      {q.isPending && <div role="status" className="space-y-3"><span className="sr-only">Loading contact…</span><Skeleton className="size-12 rounded-full" /><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>}
      {q.isError && <p role="alert" className="text-sm text-destructive">Could not load contact. <button className="font-semibold underline" onClick={() => void q.refetch()}>Retry</button></p>}
      {q.data && (
        <section>
          <div className="flex items-center gap-3">
            <ContactAvatar contact={q.data} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg font-semibold">{contactLabel(q.data)}</h2>
              <p className="text-xs text-muted-foreground">First seen {fullTime(q.data.firstSeenAt)}</p>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row icon={<Mail className="size-4" />} k="Email" v={q.data.email} />
            <Row icon={<Phone className="size-4" />} k="Phone" v={q.data.phone} />
          </dl>
          {channels.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Channels">
              {channels.map((c) => <Badge key={c} variant="outline"><ChannelGlyph channel={c} />{CHANNEL_LABEL[c] ?? c}</Badge>)}
            </div>
          )}
          <Button asChild variant="outline" size="sm" className="mt-4 w-full"><Link to={`/contacts/${contactId}`}>Open full profile<ArrowUpRight /></Link></Button>
          {q.data.blockedAt ? (
            <div role="status" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <p className="flex items-center gap-1.5 font-semibold text-destructive"><ShieldAlert className="size-4" aria-hidden="true" />Blocked for abuse</p>
              <p className="mt-1 text-muted-foreground">{q.data.blockedReason ?? "No reason recorded"}. {q.data.blockedBy ? "Blocked by a team member" : "Blocked automatically by the AI"} on {fullTime(q.data.blockedAt)}. This visitor cannot start, reopen or resume a chat.</p>
              {isAdmin
                ? <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => setUnblocking(true)}>Unblock</Button>
                : <p className="mt-2 text-xs text-muted-foreground">Only an owner or admin can unblock.</p>}
            </div>
          ) : atLeast("agent") && (
            <Button variant="outline" size="sm" className="mt-2 w-full text-destructive" onClick={() => setBlocking(true)}><ShieldAlert />Block contact</Button>
          )}
          {blocking && (
            <ConfirmModal danger title="Block this contact?" confirm="Block contact" busy={block.isPending} onConfirm={() => block.mutate()} onClose={() => setBlocking(false)}
              body={<div className="space-y-3"><p>The visitor loses access to the chat and cannot start a new conversation on any channel. Only an owner or admin can undo this.</p>
                <TextField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></div>} />
          )}
          {unblocking && (
            <ConfirmModal title="Unblock this contact?" confirm="Unblock" busy={unblock.isPending} onConfirm={() => unblock.mutate()} onClose={() => setUnblocking(false)}
              body="The visitor can start a new conversation again." />
          )}
        </section>
      )}

      <section aria-label="Conversion stage">
        <h3 className="text-sm font-semibold">Stage</h3>
        {ai?.stage ? (
          <>
            <ol className="mt-3 flex gap-1" aria-label={`Stage: ${stageLabel(ai.stage)}`}>
              {STAGES.map((s, i) => <li key={s} title={stageLabel(s)} className={cn("h-1.5 flex-1 rounded-full transition-colors", i <= idx ? (s === "handoff_requested" ? "bg-warning" : "bg-primary") : "bg-muted")} />)}
            </ol>
            <p className="mt-2 text-sm">{stageLabel(ai.stage)}</p>
          </>
        ) : <p className="mt-1 text-sm text-muted-foreground">No AI activity yet.</p>}
        {ai?.handoff && (
          <p className="mt-3 rounded-xl border border-warning/35 bg-warning/10 p-2.5 text-sm"><b className="capitalize">{ai.handoff.type.replace(/_/g, " ")} handoff</b>{ai.handoff.reason ? `: ${ai.handoff.reason}` : ""}</p>
        )}
      </section>

      {lead.length > 0 && (
        <section aria-label="Lead card" className="rounded-xl border bg-muted/40 p-3">
          <h3 className="text-sm font-semibold">Lead card</h3>
          <dl className="mt-2 space-y-1.5 text-sm">{lead.map(([k, v]) => <Row key={k} k={k.replace(/_/g, " ")} v={String(v)} />)}</dl>
        </section>
      )}

      {attrs.length > 0 && (
        <section aria-label="Custom attributes">
          <h3 className="text-sm font-semibold">Attributes</h3>
          <dl className="mt-2 space-y-1.5 text-sm">{attrs.map(([k, v]) => <Row key={k} k={k.replace(/_/g, " ")} v={String(v)} />)}</dl>
        </section>
      )}

      {earlier.length > 0 && (
        <section aria-label="Earlier conversations">
          <h3 className="text-sm font-semibold">Earlier conversations</h3>
          <ul className="mt-2 space-y-1">
            {earlier.map((i) => (
              <li key={i.conversationId}>
                <Link to={`/inbox/${i.conversationId}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                  <span className="flex items-center gap-1.5"><ChannelGlyph channel={i.channel} />{CHANNEL_LABEL[i.channel] ?? i.channel}</span>
                  <time className="text-xs text-muted-foreground" dateTime={i.at}>{timeAgo(i.at)}</time>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function Row({ k, v, icon }: { k: string; v: string | null | undefined; icon?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex items-center gap-2 capitalize text-muted-foreground">{icon}<span className={icon ? "sr-only" : undefined}>{k}</span></dt>
      <dd className={cn("min-w-0 truncate text-right", !v && "text-muted-foreground/70")}>{v || (icon ? "Not provided" : "-")}</dd>
    </div>
  );
}
