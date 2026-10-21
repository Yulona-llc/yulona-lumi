import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, ChevronUp, FlaskConical, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { AnimatePresence } from "motion/react";
import { motion } from "@/components/motion";
import { cn } from "@/lib/utils";
import { ApiError } from "../../api/client";
import { Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { ErrorState, RoleNotice, useRole } from "../common/ui";
import { builder, type BuilderMessage, type BuilderSession } from "./api";
import { AgentSheet } from "./AgentSheet";
import { activeChips, filledCount, hasDraft, sheetRows } from "./model";

const STORE = "yulona-builder-session";
const remember = (id: string | null) => { try { if (id) sessionStorage.setItem(STORE, id); else sessionStorage.removeItem(STORE); } catch { /* private mode */ } };
const recall = () => { try { return sessionStorage.getItem(STORE); } catch { return null; } };

export default function AgentBuilderPage() {
  const { isAdmin } = useRole();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [id, setId] = useState<string | null>(() => recall());
  const [pending, setPending] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const q = useQuery({
    queryKey: ["agent-builder", "session", id],
    queryFn: () => builder.session(id!),
    enabled: !!id && isAdmin,
    retry: false,
    staleTime: Infinity,
  });
  const start = useMutation({
    mutationFn: () => builder.start(),
    meta: { skipInvalidate: true },
    onSuccess: (s) => { remember(s.id); qc.setQueryData(["agent-builder", "session", s.id], s); setId(s.id); },
    onError: (e) => toast.error(errMsg(e)),
  });
  // No session, or the remembered one is gone/closed: begin a fresh one (once).
  const stale = !!id && (q.isError && q.error instanceof ApiError && q.error.status === 404 || q.data?.status === "created" || q.data?.status === "abandoned");
  useEffect(() => {
    if (!isAdmin || started.current || start.isPending) return;
    if (!id || stale) { started.current = true; remember(null); start.mutate(); }
  }, [id, stale, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useMutation({
    mutationFn: (b: { text: string } | { choice: string }) => builder.send(id!, b),
    onMutate: (b) => setPending("text" in b ? b.text : b.choice),
    onSettled: () => setPending(null),
    onError: (e) => {
      if (e instanceof ApiError && e.code === "credits_exhausted") setBlocked(true);
      toast.error(errMsg(e));
    },
  });
  const create = useMutation({
    mutationFn: (_to: "editor" | "sandbox") => builder.create(id!),
    onSuccess: (a, to) => {
      remember(null);
      toast.success(`Draft created: ${a.name}`);
      nav(`/agents/${a.agentId}${to === "sandbox" ? "?tab=sandbox" : ""}`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const s: BuilderSession | undefined = stale ? undefined : q.data;
  const shown = (s?.messages ?? []).filter((m) => m.role !== "tool");
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [shown.length, pending, send.isPending]);

  if (!isAdmin) return <Shell><div className="mx-auto max-w-md p-6"><RoleNotice what="creating agents" /><Link className="text-sm underline" to="/agents">Back to agents</Link></div></Shell>;
  if (q.isError && !stale) return <Shell><div className="mx-auto max-w-md p-6"><ErrorState error={q.error} retry={() => void q.refetch()} /></div></Shell>;

  const submit = (b: { text: string } | { choice: string }) => { if (!send.isPending && !blocked) send.mutate(b); };
  const rows = s ? sheetRows(s.draft) : [];
  const chips = s && !send.isPending && !pending ? activeChips(s.messages) : [];
  const canCreate = !!s && hasDraft(s.draft);
  const busy = create.isPending;
  const actions = (
    <div className="flex flex-col gap-2">
      <Button disabled={!canCreate || busy} onClick={() => create.mutate("editor")}>{busy && create.variables === "editor" && <Spinner />}Create draft</Button>
      <Button variant="outline" disabled={!canCreate || busy} onClick={() => create.mutate("sandbox")}>
        {busy && create.variables === "sandbox" ? <Spinner /> : <FlaskConical />}Try it in the sandbox
      </Button>
      <p className="text-xs text-muted-foreground">{canCreate ? "Creates a draft. Nothing goes live until you publish it." : "Needs a name, a persona and a greeting first."}</p>
    </div>
  );

  return (
    <Shell>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-2 sm:px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to agents"><Link to="/agents"><ArrowLeft /></Link></Button>
        <Sparkles className="size-4 text-primary" aria-hidden />
        <h1 className="font-display text-base font-semibold">Create with AI</h1>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Conversation" className="flex min-h-0 flex-col">
          <div role="log" aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
            <div className="mx-auto flex max-w-2xl flex-col gap-3">
              {!s ? <div role="status" className="space-y-3"><span className="sr-only">Starting the assistant…</span><Skeleton className="h-16 w-4/5 rounded-2xl" /><Skeleton className="h-10 w-3/5 rounded-2xl" /></div> : (
                <AnimatePresence initial={false}>
                  {shown.map((m) => <Bubble key={m.id} m={m} />)}
                  {pending && <Bubble key="pending" m={{ id: "pending", role: "user", content: pending, payload: null, createdAt: "" }} />}
                </AnimatePresence>
              )}
              {send.isPending && <Typing />}
              {s?.draft.ready && !send.isPending && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-primary/40 bg-accent p-4">
                  <p className="font-display font-semibold">Your draft is ready</p>
                  <p className="mt-1 text-sm text-accent-foreground/80">Create it, then try it in the sandbox before you publish. You can keep chatting to change anything first.</p>
                  <Button className="mt-3" disabled={busy} onClick={() => create.mutate("editor")}>{busy && <Spinner />}Create draft</Button>
                </motion.div>
              )}
              <div ref={endRef} />
            </div>
          </div>
          <div className="shrink-0 border-t bg-card px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
            <div className="mx-auto max-w-2xl">
              {chips.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Quick replies">
                  {chips.map((c) => <Button key={c} size="sm" variant="outline" className="rounded-full" onClick={() => submit({ choice: c })}>{c}</Button>)}
                </div>
              )}
              {blocked && <p role="alert" className="mb-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">AI credits are used up. <Link className="font-medium underline" to="/settings/usage">Buy credits</Link> to keep building.</p>}
              <button type="button" className="mb-2 flex w-full items-center justify-between rounded-lg border bg-muted/50 px-3 py-2 text-sm lg:hidden" onClick={() => setSheetOpen(true)}>
                <span>Agent sheet <span className="text-muted-foreground">{filledCount(rows)} of {rows.length} covered</span></span><ChevronUp className="size-4" aria-hidden />
              </button>
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t && s) { setText(""); submit({ text: t }); } }}>
                <Textarea aria-label="Your answer" rows={1} value={text} maxLength={4000} disabled={!s || blocked} placeholder="Type your answer"
                  className="max-h-32 min-h-11 resize-none" onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
                <Button type="submit" size="icon" aria-label="Send" disabled={!s || !text.trim() || send.isPending || blocked}><Send /></Button>
              </form>
            </div>
          </div>
        </section>
        <aside aria-label="Agent sheet" className="hidden min-h-0 overflow-y-auto border-l bg-muted/30 p-5 lg:block">
          {s ? <><AgentSheet draft={s.draft} /><div className="mt-4">{actions}</div></> : <Skeleton className="h-72 rounded-xl" />}
        </aside>
      </div>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="overflow-y-auto px-4 pt-5">
          <SheetHeader className="sr-only"><SheetTitle>Agent sheet</SheetTitle><SheetDescription>What the assistant has set up so far.</SheetDescription></SheetHeader>
          {s && <><AgentSheet draft={s.draft} /><div className="mt-4">{actions}</div></>}
        </SheetContent>
      </Sheet>
    </Shell>
  );
}

/** Full-screen surface above the app shell (keeps the thumb zone for the composer). */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[45] flex flex-col bg-background text-foreground">{children}</div>;
}

function Bubble({ m }: { m: BuilderMessage }) {
  const mine = m.role === "user";
  return (
    <motion.div layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
      className={cn("flex items-end gap-2", mine && "justify-end")}>
      {!mine && <span className="mb-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground" aria-hidden><Bot className="size-4" /></span>}
      <p className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[75%]",
        mine ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md border bg-card")}>
        <span className="sr-only">{mine ? "You: " : "Assistant: "}</span>{m.content}
      </p>
    </motion.div>
  );
}

function Typing() {
  return (
    <div role="status" className="flex items-end gap-2" data-testid="typing">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground" aria-hidden><Bot className="size-4" /></span>
      <span className="flex items-center gap-1 rounded-2xl rounded-bl-md border bg-card px-3.5 py-3">
        <span className="sr-only">The assistant is typing</span>
        {[0, 1, 2].map((i) => <motion.span key={i} aria-hidden className="size-1.5 rounded-full bg-muted-foreground" animate={{ y: [0, -3, 0] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />)}
      </span>
    </div>
  );
}
