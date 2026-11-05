import { keys } from "@/api/keys";
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { AlertTriangle, ArrowLeft, Bot, Check, PanelRight, RotateCcw, UserRound } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { motion } from "@/components/motion";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { inboxApi, loadAiState, markRead, type MessageView, type MsgPage } from "./api";
import { contactLabel } from "./format";
import { CHANNEL_LABEL } from "./format";
import { ChannelGlyph, ContactAvatar } from "./parts";
import Thread from "./Thread";
import Composer from "./Composer";
import TagPicker from "../ops-settings/TagPicker";
import ContactPanel, { stageLabel } from "./ContactPanel";
import { useTyping } from "../realtime/hooks";

export default function ConversationView() {
  const { id = "" } = useParams();
  const { session } = useAuth();
  const me = session?.user;
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const [panel, setPanel] = useState(false);
  const typing = useTyping(id);

  const conv = useQuery({ queryKey: ["conversation", id], queryFn: () => inboxApi.get(id) });
  const msgs = useQuery({ queryKey: ["messages", id], queryFn: () => inboxApi.messages(id) });
  const items = (msgs.data?.items ?? []) as MessageView[];
  const ai = useQuery({
    queryKey: ["ai-state", id, lastAiId(items)],
    queryFn: () => loadAiState(id, items),
    enabled: msgs.isSuccess,
  });
  const users = useQuery({ queryKey: keys.usersInbox, queryFn: inboxApi.users, staleTime: 5 * 60_000, retry: false });

  useEffect(() => { markRead(id); }, [id, msgs.data?.items.length]);
  useEffect(() => { setErr(null); }, [id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["conversation", id] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : "Something went wrong.");

  const patchMsgs = (f: (items: MessageView[]) => MessageView[]) =>
    qc.setQueryData<MsgPage>(["messages", id], (o) => (o ? { ...o, items: f(o.items as MessageView[]) } : o));

  const send = useCallback(async (text: string, kind: "reply" | "note", retryId?: string) => {
    setErr(null);
    const tmp = retryId ?? `tmp-${crypto.randomUUID()}`;
    const optimistic = {
      id: tmp, conversationId: id, senderType: kind === "note" ? "note" : "human", senderUserId: me?.id, senderName: me?.name,
      content: text, createdAt: new Date().toISOString(), pending: true,
    } as MessageView;
    patchMsgs((l) => (retryId ? l.map((m) => (m.id === tmp ? optimistic : m)) : [...l, optimistic]));
    try {
      const real = await inboxApi.send(id, text, kind);
      // The websocket may already have delivered the real message.
      patchMsgs((l) => (l.some((m) => m.id === real.id) ? l.filter((m) => m.id !== tmp) : l.map((m) => (m.id === tmp ? real : m))));
      refresh();
    } catch (e) {
      patchMsgs((l) => l.map((m) => (m.id === tmp ? { ...m, pending: false, failed: true } : m)));
      fail(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, me?.id, me?.name]);

  const act = useMutation({
    mutationFn: (a: "takeover" | "return" | "resolve" | "reopen") =>
      a === "takeover" ? inboxApi.takeover(id) : a === "return" ? inboxApi.returnToAi(id)
        : inboxApi.patch(id, { status: a === "resolve" ? "resolved" : "open" }),
    onSuccess: (_d, a) => { refresh(); void qc.invalidateQueries({ queryKey: ["messages", id] }); toast.success(a === "takeover" ? "You took over" : a === "return" ? "Returned to the AI" : a === "resolve" ? "Resolved" : "Reopened"); },
    onError: fail,
  });
  const assign = useMutation({
    mutationFn: (uid: string | null) => inboxApi.patch(id, { assignedUserId: uid }),
    onSuccess: refresh, onError: fail,
  });

  const loadOlder = async () => {
    const cursor = msgs.data?.nextCursor;
    if (!cursor) return;
    setOlder(true);
    try {
      const page = await inboxApi.messages(id, cursor);
      qc.setQueryData<MsgPage>(["messages", id], (o) => o && { items: [...page.items, ...o.items], nextCursor: page.nextCursor });
    } catch (e) { fail(e); } finally { setOlder(false); }
  };

  if (conv.isPending || msgs.isPending) {
    return (
      <div role="status" aria-live="polite" className="flex min-h-0 flex-1 flex-col">
        <span className="sr-only">Loading conversation…</span>
        <div className="flex items-center gap-3 border-b p-4"><Skeleton className="size-10 rounded-full" /><div className="space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3.5 w-24" /></div></div>
        <div className="flex-1 space-y-4 p-5">
          <Skeleton className="h-12 w-3/5 rounded-2xl" /><Skeleton className="ml-auto h-16 w-1/2 rounded-2xl" /><Skeleton className="h-10 w-2/5 rounded-2xl" />
        </div>
      </div>
    );
  }
  if (conv.isError || msgs.isError) {
    const notFound = conv.error instanceof ApiError && conv.error.status === 404;
    return (
      <div className="m-auto max-w-sm p-8 text-center" role="alert">
        <AlertTriangle className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <p className="font-display text-lg font-semibold">{notFound ? "Conversation not found" : "Could not load this conversation"}</p>
        <p className="mt-1 text-sm text-muted-foreground">{notFound ? "It may have been deleted or belong to another workspace." : "Check your connection and try again."}</p>
        <div className="mt-4 flex justify-center gap-2">
          {!notFound && <Button onClick={() => { void conv.refetch(); void msgs.refetch(); }}>Retry</Button>}
          <Button asChild variant="outline"><Link to="/inbox">Back to inbox</Link></Button>
        </div>
      </div>
    );
  }

  const c = conv.data;
  const mine = c.assignedUserId === me?.id;
  const busy = act.isPending || assign.isPending;
  const waiting = c.status === "pending_human";
  const resolved = c.status === "resolved";
  const owner = c.assignedUserId ? (users.data?.items.find((u) => u.id === c.assignedUserId)?.name ?? (mine ? me?.name : undefined)) : undefined;
  const active = (users.data?.items ?? []).filter((u) => u.status === "active" || u.id === c.assignedUserId);
  const statusText = resolved ? "Resolved" : waiting ? "Waiting for a person" : c.handler === "ai" ? "The AI is answering" : owner ? `${owner} is handling this` : "A teammate is handling this";
  const person = c.handler === "human" || waiting;

  return (
    <motion.div initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} className="flex min-h-0 flex-1">
      <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b bg-card">
          <div className="flex items-center gap-2 px-2 pb-1 pt-2 sm:px-4 sm:pt-3">
            <Button asChild variant="ghost" size="icon" className="md:hidden"><Link to="/inbox" aria-label="Back to inbox"><ArrowLeft /></Link></Button>
            <ContactAvatar contact={c.contact} channel={c.channel} />
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-display text-base font-semibold leading-tight sm:text-lg">{contactLabel(c.contact)}</h2>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ChannelGlyph channel={c.channel} className="size-3" />{CHANNEL_LABEL[c.channel] ?? c.channel}{ai.data?.stage && <Badge variant="outline" className="ml-1 px-2 py-0 font-medium">{stageLabel(ai.data.stage)}</Badge>}{c.contact.blockedAt && <Badge variant="destructive" className="ml-1 px-2 py-0">Blocked for abuse</Badge>}</p>
            </div>
            <Button variant="ghost" size="icon" className="@6xl:hidden" aria-label="Contact details" aria-expanded={panel} onClick={() => setPanel(true)}><PanelRight /></Button>
          </div>
          <div className="px-3 pb-2 sm:px-4"><TagPicker resource="conversations" id={id} /></div>

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 px-3 pb-3 pt-1.5 sm:px-4">
            <div className="flex min-w-0 items-center gap-3">
            <div className="relative inline-grid shrink-0 grid-cols-2 rounded-full bg-muted p-0.5 text-xs font-semibold" aria-hidden="true">
              {([["ai", "AI", Bot], ["person", "Person", UserRound]] as const).map(([k, label, Icon]) => {
                const on = resolved ? false : k === "person" ? person : !person;
                return (
                  <span key={k} className={cn("relative z-10 flex min-w-16 items-center justify-center gap-1.5 px-2.5 py-1 transition-colors", on ? (waiting ? "text-foreground" : "text-foreground") : "text-muted-foreground")}>
                    {on && <motion.span layoutId="handler-pill" transition={{ type: "spring", stiffness: 420, damping: 32 }} className={cn("absolute inset-0 -z-10 rounded-full shadow-sm", waiting ? "bg-warning/25" : k === "ai" ? "bg-card" : "bg-primary/25")} />}
                    <Icon className="size-3.5" />{label}
                  </span>
                );
              })}
            </div>
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium" role="status">
              {waiting && <span className="relative flex size-2" aria-hidden="true"><span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-70" /><span className="relative inline-flex size-2 rounded-full bg-warning" /></span>}
              <span className="truncate">{statusText}</span>
            </p>
            </div>

            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Select value={c.assignedUserId ?? "none"} disabled={busy} onValueChange={(v) => assign.mutate(v === "none" ? null : v)}>
                <SelectTrigger aria-label="Assignee" className="min-w-0 flex-1 sm:w-40 sm:flex-none"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {active.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                  {!users.data && me && <SelectItem value={me.id}>{me.name}</SelectItem>}
                </SelectContent>
              </Select>
              {c.handler === "ai"
                ? <Button disabled={busy || resolved} onClick={() => act.mutate("takeover")}>Take over</Button>
                : <Button variant="outline" disabled={busy || !!c.contact.blockedAt} title={c.contact.blockedAt ? "Unblock the contact first" : undefined} onClick={() => act.mutate("return")}>{mine ? "Return to AI" : "Hand back to AI"}</Button>}
              {resolved
                ? <Button variant="ghost" disabled={busy} onClick={() => act.mutate("reopen")}><RotateCcw /><span className="max-sm:sr-only">Reopen</span></Button>
                : <Button variant="ghost" disabled={busy} onClick={() => act.mutate("resolve")}><Check /><span className="max-sm:sr-only">Resolve</span></Button>}
            </div>
          </div>
        </header>

        <AnimatePresence initial={false}>
          {waiting && (
            <motion.p key="wait" role="status" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="shrink-0 overflow-hidden border-b border-warning/30 bg-warning/10 text-sm text-foreground">
              <span className="flex items-center gap-2 px-4 py-2.5"><AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />The AI has stopped and needs a person. Reply or take over to continue.</span>
            </motion.p>
          )}
        </AnimatePresence>
        {err && <div className="shrink-0 px-3 pt-3"><Alert variant="destructive">{err}</Alert></div>}
        <Thread key={id} messages={items} hasOlder={!!msgs.data?.nextCursor} loadingOlder={older} onLoadOlder={() => void loadOlder()}
          onRetry={(m) => void send(m.content, m.senderType === "note" ? "note" : "reply", m.id)} typing={typing} />
        <Composer conversationId={id} handler={c.handler} disabled={resolved} onSend={(t, k) => void send(t, k)} />
      </section>

      <div className="hidden w-80 shrink-0 overflow-y-auto border-l bg-card @6xl:block">
        <ContactPanel contactId={c.contact.id} conversationId={id} ai={ai.data} />
      </div>
      <Sheet open={panel} onOpenChange={setPanel}>
        <SheetContent side="right" className="gap-0 overflow-y-auto">
          <SheetHeader className="border-b"><SheetTitle>Contact</SheetTitle><SheetDescription>Who you are talking to and what the AI has learned.</SheetDescription></SheetHeader>
          <ContactPanel contactId={c.contact.id} conversationId={id} ai={ai.data} />
        </SheetContent>
      </Sheet>
    </motion.div>
  );
}

function lastAiId(l: MessageView[]): string | undefined {
  for (let i = l.length - 1; i >= 0; i--) if (l[i]!.senderType === "ai") return l[i]!.id;
  return undefined;
}
