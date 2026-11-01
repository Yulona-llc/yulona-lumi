import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { Building2, CheckCircle2, Clock, HandHelping, Mail, MessageSquareQuote, Moon, Phone, ShieldAlert, Sparkles, TriangleAlert, UserPlus, Undo2, CircleHelp, ExternalLink, type LucideIcon } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { ag, errMsg } from "../common/api";
import { Empty, ErrorState, Loading, Modal, PageHeader, RoleNotice, TextArea, useRole } from "../common/ui";
import { initials, useNow } from "../ops-settings/hooks";
import { label, ops, type HandoffItem, type HandoffType } from "../ops-settings/opsApi";

/**
 * Three kinds of baton pass, each with its own colour, icon and rail so they read at a glance:
 * uncertain (amber question mark), lead ready (ember sparkle), system failure (red triangle).
 */
const TYPES: Record<HandoffType, { name: string; hint: string; icon: LucideIcon; tile: string; rail: string; chip: string }> = {
  uncertainty: { name: "Uncertain", hint: "The AI could not answer from your knowledge base", icon: CircleHelp, tile: "bg-warning/14 text-warning", rail: "bg-warning", chip: "border-warning/40" },
  stage: { name: "Lead ready", hint: "A qualified lead is ready for a person", icon: Sparkles, tile: "bg-primary/18 text-accent-foreground", rail: "bg-primary", chip: "border-primary/50" },
  system_failure: { name: "System failure", hint: "A tool or calendar call failed", icon: TriangleAlert, tile: "bg-destructive/12 text-destructive", rail: "bg-destructive", chip: "border-destructive/40" },
  abuse: { name: "Blocked for abuse", hint: "The visitor was blocked after repeated abuse or spam. Review it and unblock from the contact panel if it was a mistake", icon: ShieldAlert, tile: "bg-destructive/12 text-destructive", rail: "bg-destructive", chip: "border-destructive/40" },
};
const ORDER: HandoffType[] = ["stage", "uncertainty", "system_failure", "abuse"];
const STATES = [["active", "Active"], ["open", "Waiting"], ["claimed", "Claimed"], ["resolved", "Resolved"]] as const;

/** Waiting time with urgency: calm under 10 min, amber to 30, red after. */
export function waitInfo(iso: string, now: number) {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  const text = mins < 1 ? "just now" : mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} d`;
  const tier = mins >= 30 ? "late" : mins >= 10 ? "slow" : "fresh";
  return { mins, text, tier } as const;
}
const TIER_CLS = { fresh: "bg-muted text-muted-foreground", slow: "bg-warning/14 text-warning", late: "bg-destructive/12 text-destructive" } as const;

export default function AttentionPage() {
  const { atLeast, isAdmin, role } = useRole();
  const allowed = atLeast("agent");
  const [state, setState] = useState<(typeof STATES)[number][0]>("active");
  const [types, setTypes] = useState<HandoffType[]>([]);
  const [mine, setMine] = useState(false);
  const [resolving, setResolving] = useState<HandoffItem | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const counts = useQuery({ queryKey: ["attention-counts"], queryFn: ops.counts, refetchInterval: 15_000, enabled: allowed });
  const filters = { state, type: types.join(",") || undefined, assignee: mine ? "me" : undefined };
  const q = useInfiniteQuery({ queryKey: ["attention", filters], queryFn: ({ pageParam }) => ops.attention(filters, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined, refetchInterval: 15_000, enabled: allowed });
  const now = useNow(15_000);
  const items = useMemo(() => (q.data?.pages.flatMap((p) => p.items) ?? []).filter((h) => !gone.has(h.id)), [q.data, gone]);
  if (!allowed) return <><PageHeader title="Needs attention" /><RoleNotice what={`the handoff queue (current role: ${role})`} /></>;
  const toggleType = (t: HandoffType) => setTypes((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  return (
    <div>
      <PageHeader title="Needs attention" subtitle="Conversations where the AI stopped and a person should step in. Longest waiting first." />
      <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-3" role="group" aria-label="Filter by type">
        {ORDER.map((k) => {
          const t = TYPES[k];
          const on = types.includes(k);
          const n = counts.data?.[k];
          return (
            <button key={k} type="button" aria-pressed={on} onClick={() => toggleType(k)}
              className={cn("group flex flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left sm:flex-row sm:items-center sm:gap-3 sm:p-3.5 outline-none transition-[border-color,box-shadow] hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/30", on && cn("shadow-sm", t.chip))}>
              <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl sm:size-11", t.tile)}><t.icon className="size-5" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold sm:text-base">{t.name}
                  <span className="font-display text-xl tabular-nums" aria-label={`${n ?? 0} open`}>{n ?? "-"}</span></span>
                <span className="hidden text-xs leading-snug text-muted-foreground sm:block">{t.hint}</span>
              </span>
            </button>);
        })}
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Tabs value={state} onValueChange={(v) => setState(v as typeof state)}>
          <TabsList aria-label="State">{STATES.map(([k, n]) => <TabsTrigger key={k} value={k}>{n}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="flex min-h-11 items-center gap-2.5 sm:min-h-9">
          <Switch id="mine" checked={mine} onCheckedChange={setMine} />
          <Label htmlFor="mine" className="cursor-pointer">Assigned to me{counts.data ? <span className="ml-1 tabular-nums text-muted-foreground">({counts.data.mine})</span> : null}</Label>
        </div>
      </div>
      {q.isPending ? <Loading label="Loading queue" rows={3} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : items.length === 0 ? (
        <Empty icon={<CheckCircle2 className="size-6" />} title="Queue is clear" body={state === "resolved" ? "Nothing has been resolved yet." : "No conversation is waiting for a person. The AI is handling everything."} />
      ) : (
        <ul className="space-y-3" aria-label="Handoff queue">
          <AnimatePresence initial={false} mode="popLayout">
            {items.map((h) => (
              <motion.li key={h.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 72, transition: { duration: 0.22 } }} transition={{ duration: 0.25 }}>
                <Item h={h} now={now} isAdmin={isAdmin} onResolve={() => setResolving(h)} onLeave={() => setGone((s) => new Set(s).add(h.id))} />
              </motion.li>))}
          </AnimatePresence>
        </ul>)}
      {q.hasNextPage && <div className="mt-4 text-center"><Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more</Button></div>}
      {resolving && <ResolveModal h={resolving} onClose={() => setResolving(null)} onDone={() => { const id = resolving.id; setResolving(null); setGone((s) => new Set(s).add(id)); }} />}
    </div>
  );
}

function who(h: HandoffItem) { return h.contact.name ?? h.contact.email ?? h.contact.phone ?? "Anonymous visitor"; }

/** Lead card: reads like a business card (who, where to reach them, what they want). */
function LeadCard({ h }: { h: HandoffItem }) {
  const lead = (h.leadCard ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof lead[k] === "string" || typeof lead[k] === "number" ? String(lead[k]) : "");
  const name = s("name") || who(h);
  const email = s("email") || h.contact.email || "";
  const phone = s("phone") || h.contact.phone || "";
  const company = s("company");
  const facts = (["need", "budget", "timeline"] as const).map((k) => [k, s(k)] as const).filter(([, v]) => v);
  const score = Number(s("score"));
  const known = new Set(["name", "email", "phone", "company", "need", "budget", "timeline", "score", "summary"]);
  const extra = Object.entries(lead).filter(([k, v]) => !known.has(k) && v !== null && v !== "" && typeof v !== "object");
  return (
    <section aria-label="Lead card" className="overflow-hidden rounded-xl border bg-muted/40">
      <div className="flex items-start gap-3 p-3.5">
        <Avatar className="size-11"><AvatarFallback className="bg-sidebar text-sm text-sidebar-foreground">{initials(name)}</AvatarFallback></Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-semibold leading-tight">{name}</p>
          {company && <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground"><Building2 className="size-3.5 shrink-0" aria-hidden="true" />{company}</p>}
          <div className="mt-1.5 space-y-0.5 text-sm">
            {email && <a href={`mailto:${email}`} className="flex items-center gap-1.5 truncate text-muted-foreground hover:text-foreground"><Mail className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{email}</span></a>}
            {phone && <a href={`tel:${phone.replace(/\s/g, "")}`} className="flex items-center gap-1.5 truncate text-muted-foreground hover:text-foreground"><Phone className="size-3.5 shrink-0" aria-hidden="true" /><span className="tabular-nums">{phone}</span></a>}
          </div>
        </div>
        {Number.isFinite(score) && s("score") && (
          <div className="shrink-0 text-center" title="Lead score">
            <p className={cn("font-display text-2xl font-semibold leading-none tabular-nums", score >= 75 ? "text-success" : score >= 50 ? "text-warning" : "text-muted-foreground")}>{score}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">score</p>
          </div>)}
      </div>
      {(facts.length > 0 || extra.length > 0) && (
        <dl className="grid gap-px border-t bg-border sm:grid-cols-3">
          {[...facts, ...extra.map(([k, v]) => [k, String(v)] as const)].map(([k, v]) => (
            <div key={k} className="bg-card px-3.5 py-2"><dt className="text-xs capitalize text-muted-foreground">{k}</dt><dd className="truncate text-sm font-medium">{v}</dd></div>))}
        </dl>)}
    </section>
  );
}

function Item({ h, now, isAdmin, onResolve, onLeave }: { h: HandoffItem; now: number; isAdmin: boolean; onResolve: () => void; onLeave: () => void }) {
  const t = TYPES[h.type];
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useAuth().session?.user.id;
  const users = useQuery({ queryKey: ["users"], queryFn: ag.users, enabled: isAdmin });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["attention"] }); void qc.invalidateQueries({ queryKey: ["attention-counts"] }); };
  const claim = useMutation({
    mutationFn: (force?: boolean) => ops.claim(h.id, force),
    onSuccess: () => { toast.success("Claimed", { description: `${who(h)} is yours now.` }); refresh(); onLeave(); nav(`/inbox/${h.conversation.id}`); },
    onError: (e) => { if (!(e instanceof ApiError && e.status === 409)) toast.error("Could not claim", { description: errMsg(e) }); },
  });
  const assign = useMutation({
    mutationFn: (u: { id: string; name: string }) => ops.assign(h.id, u.id).then((r) => ({ r, name: u.name })),
    onSuccess: ({ name }) => { toast.success("Assigned", { description: `Handed to ${name}.` }); refresh(); },
    onError: (e) => toast.error("Could not assign", { description: errMsg(e) }),
  });
  const release = useMutation({ mutationFn: () => ops.release(h.id), onSuccess: () => { toast.success("Released", { description: "Back in the waiting queue." }); refresh(); }, onError: (e) => toast.error("Could not release", { description: errMsg(e) }) });
  const conflict = claim.error instanceof ApiError && claim.error.status === 409;
  const resolved = h.state === "resolved";
  const mineClaim = h.assignedUserId === me;
  const w = waitInfo(resolved && h.resolvedAt ? h.resolvedAt : h.createdAt, now);
  const waited = resolved && h.resolvedAt ? Math.max(0, Math.floor((new Date(h.resolvedAt).getTime() - new Date(h.createdAt).getTime()) / 60000)) : 0;
  const hasLead = h.type === "stage" || (h.leadCard && Object.keys(h.leadCard).length > 0);
  return (
    <article className="relative overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgb(15_26_47/0.04)]">
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1.5", t.rail)} />
      <div className="space-y-3 p-4 pl-5">
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", t.tile)}><t.icon className="size-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1 basis-40">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={h.type === "system_failure" || h.type === "abuse" ? "destructive" : h.type === "uncertainty" ? "warning" : "default"}>{t.name}</Badge>
              {h.outOfHours && <Badge variant="secondary"><Moon aria-hidden="true" />Out of hours</Badge>}
              <Badge variant={h.state === "open" ? "outline" : h.state === "claimed" ? "info" : "success"}>{h.state === "open" ? "Waiting" : label(h.state)}</Badge>
            </div>
            <h2 className="mt-1.5 truncate text-base font-semibold">{who(h)} <span className="text-sm font-normal text-muted-foreground">via {h.conversation.channel}</span></h2>
          </div>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums", resolved ? "bg-success/12 text-success" : TIER_CLS[w.tier])} aria-live="off">
            {resolved ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <Clock className={cn("size-3.5", w.tier === "late" && "animate-pulse")} aria-hidden="true" />}
            {resolved ? `Resolved in ${waited < 60 ? `${waited} min` : `${Math.floor(waited / 60)} h`}` : <>Waiting {w.text}</>}
          </span>
        </header>
        <div>
          <p className="text-[0.9375rem] font-medium">{h.reason}</p>
          {h.summary && <p className="mt-1 text-sm text-muted-foreground">{h.summary}</p>}
        </div>
        {hasLead && <LeadCard h={h} />}
        {h.conversation.lastMessagePreview && <p className="flex items-start gap-2 rounded-lg bg-muted/70 px-3 py-2 text-sm text-muted-foreground"><MessageSquareQuote className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span className="line-clamp-2">{h.conversation.lastMessagePreview}</span></p>}
        {h.assignedUserName && <p className="text-xs text-muted-foreground">{h.state === "claimed" ? "Claimed by" : "Suggested for"} {h.assignedUserName}</p>}
        {h.resolutionNote && <p className="text-xs text-muted-foreground">Resolution: {h.resolutionNote}</p>}
        {conflict && <p role="alert" className="rounded-lg bg-warning/12 px-3 py-2 text-sm text-warning">Someone else claimed this first. {isAdmin && <button type="button" className="font-semibold underline" onClick={() => claim.mutate(true)}>Take over anyway</button>}</p>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!resolved && h.state === "open" && <Button size="lg" className="max-sm:order-first max-sm:w-full sm:min-h-10" disabled={claim.isPending} onClick={() => claim.mutate(undefined)}><HandHelping />Claim</Button>}
          {!resolved && <Button variant="outline" className="max-sm:flex-1" onClick={onResolve}><CheckCircle2 />Resolve</Button>}
          {!resolved && h.state === "claimed" && (mineClaim || isAdmin) && <Button variant="outline" className="max-sm:flex-1" disabled={release.isPending} onClick={() => release.mutate()}><Undo2 />Release</Button>}
          {!resolved && isAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" className="max-sm:flex-1" disabled={assign.isPending}><UserPlus />Assign</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                {(users.data ?? []).filter((u) => u.status === "active").map((u) => <DropdownMenuItem key={u.id} onSelect={() => assign.mutate({ id: u.id, name: u.name })}>{u.name}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>)}
          <Button variant="ghost" asChild className="max-sm:flex-1 sm:ml-auto"><Link to={`/inbox/${h.conversation.id}`}><ExternalLink />Open conversation</Link></Button>
        </div>
      </div>
      <span className="sr-only" aria-live="polite">{claim.isPending ? "Claiming" : ""}</span>
    </article>
  );
}

function ResolveModal({ h, onClose, onDone }: { h: HandoffItem; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [ret, setRet] = useState(false);
  const m = useMutation({
    mutationFn: () => ops.resolve(h.id, { ...(note.trim() ? { note: note.trim() } : {}), returnToAi: ret }),
    onSuccess: () => {
      toast.success("Resolved", { description: ret ? "The AI is handling this conversation again." : "The conversation stays with your team." });
      void qc.invalidateQueries({ queryKey: ["attention"] }); void qc.invalidateQueries({ queryKey: ["attention-counts"] });
      onDone();
    },
    onError: (e) => toast.error("Could not resolve", { description: errMsg(e) }),
  });
  return (
    <Modal title="Resolve handoff" description={`${who(h)}: ${h.reason}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <TextArea label="Resolution note (optional)" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex items-start gap-3 rounded-xl border bg-muted/50 p-3">
          <Switch id="ret" checked={ret} onCheckedChange={setRet} className="mt-0.5" />
          <div><Label htmlFor="ret" className="cursor-pointer">Hand the conversation back to the AI</Label><p className="mt-0.5 text-sm text-muted-foreground">{ret ? "The AI replies to the next message." : "Off: your team keeps replying."}</p></div>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={m.isPending}>Resolve</Button>
        </div>
      </form>
    </Modal>
  );
}
