import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Send, Sparkles } from "lucide-react";
import type { CopilotAllowance } from "@yulona/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ApiError } from "../../api/client";
import { Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { ErrorState, useRole } from "../common/ui";
import { copilotApi, remainingText, type CopilotMessage, type CopilotSession } from "./api";
import { Blocks } from "./Blocks";

const STORE = "lumi-copilot-session";
const remember = (id: string | null) => { try { if (id) sessionStorage.setItem(STORE, id); else sessionStorage.removeItem(STORE); } catch { /* private mode */ } };
const recall = () => { try { return sessionStorage.getItem(STORE); } catch { return null; } };

/** Header button + drawer. Renders nothing for roles below admin. */
export function AskLumi() {
  const { isAdmin } = useRole();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <Button variant="outline" size="sm" className="h-10 gap-1.5 rounded-xl" onClick={() => setOpen(true)} aria-label="Ask Lumi">
        <Sparkles className="size-4 text-primary" aria-hidden /><span className="max-sm:sr-only">Ask Lumi</span>
      </Button>
      {open && <CopilotDrawer open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function CopilotDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["copilot", "status"], queryFn: copilotApi.status, enabled: open, retry: false, staleTime: 15_000 });
  const [id, setId] = useState<string | null>(recall);
  const [allowance, setAllowance] = useState<CopilotAllowance | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<string | null>(null);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const allowed = status.data?.access === "allowed";
  const key = ["copilot", "session", id];

  const q = useQuery({ queryKey: key, queryFn: () => copilotApi.session(id!), enabled: open && allowed && !!id, retry: false, staleTime: Infinity });
  const start = useMutation({
    mutationFn: copilotApi.start,
    meta: { skipInvalidate: true },
    onSuccess: (s) => { remember(s.id); qc.setQueryData(["copilot", "session", s.id], s); setId(s.id); },
    onError: (e) => { if (e instanceof ApiError && e.code === "copilot_limit_reached") setLimit(e.message); },
  });
  const stale = !!id && (q.isError && q.error instanceof ApiError && q.error.status === 404 || q.data?.status === "closed");
  useEffect(() => {
    if (!open || !allowed || started.current || start.isPending) return;
    if (!id || stale) { started.current = true; remember(null); start.mutate(); }
  }, [open, allowed, id, stale]); // eslint-disable-line react-hooks/exhaustive-deps

  const append = (...m: CopilotMessage[]) => qc.setQueryData<CopilotSession>(key, (s) => (s ? { ...s, messages: [...s.messages, ...m] } : s));
  const send = useMutation({
    mutationFn: (b: { text: string } | { choice: string }) => copilotApi.send(id!, b),
    meta: { skipInvalidate: true },
    onMutate: (b) => { const t = "text" in b ? b.text : b.choice; setPending(t); },
    onSuccess: (r) => { setAllowance(r.allowance); append(...r.messages); void qc.invalidateQueries({ queryKey: ["overview"] }); void qc.invalidateQueries({ queryKey: ["agents"] }); },
    onSettled: () => setPending(null),
    onError: (e) => {
      if (e instanceof ApiError && (e.code === "copilot_limit_reached" || e.code === "copilot_requires_plan")) { setLimit(e.message); void qc.invalidateQueries({ queryKey: ["copilot", "status"] }); }
      else setLimit(errMsg(e));
    },
  });
  const act = useMutation({
    mutationFn: (a: { token: string; kind: "confirm" | "cancel" }) => (a.kind === "confirm" ? copilotApi.confirm(id!, a.token) : copilotApi.cancel(id!, a.token)),
    meta: { skipInvalidate: true },
    onSuccess: (r, a) => { setResolved((s) => new Set(s).add(a.token)); append(r.message); void qc.invalidateQueries({ queryKey: ["agents"] }); void qc.invalidateQueries({ queryKey: ["overview"] }); },
    onError: (e, a) => { setResolved((s) => new Set(s).add(a.token)); setLimit(errMsg(e)); },
  });

  const s = stale ? undefined : q.data;
  const shown = s?.messages ?? [];
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [shown.length, pending]);
  const submit = (t: string) => { const v = t.trim(); if (!v || send.isPending || !id) return; setLimit(null); setText(""); send.mutate({ text: v }); };
  const choose = (t: string) => { if (!send.isPending && id) { setLimit(null); send.mutate({ choice: t }); } };
  const alw = allowance ?? status.data?.allowance;
  const busy = send.isPending || act.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md gap-0 p-0 sm:max-w-md" aria-describedby="copilot-desc">
        <SheetHeader className="border-b p-4 pr-12">
          <SheetTitle className="flex items-center gap-2"><Sparkles className="size-5 text-primary" aria-hidden />Ask Lumi</SheetTitle>
          <SheetDescription id="copilot-desc">Tell Lumi what to change in your workspace. Lumi never publishes without your confirmation.</SheetDescription>
        </SheetHeader>
        {status.isPending ? <div className="space-y-3 p-4"><Skeleton className="h-16" /><Skeleton className="h-24" /></div>
          : status.isError ? <div className="p-4"><ErrorState error={status.error} retry={() => void status.refetch()} /></div>
          : !allowed ? <Locked />
          : (
            <>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-live="polite" aria-label="Conversation with Lumi">
                {!s && !q.isError ? <Skeleton className="h-20" /> : q.isError && !stale ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : shown.map((m) => (
                  <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[92%] min-w-0 rounded-2xl px-3.5 py-2.5 text-[0.9375rem]", m.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted")}>
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      {m.payload?.blocks && <Blocks blocks={m.payload.blocks} busy={busy} resolved={resolved} onChoice={choose} onConfirm={(t) => act.mutate({ token: t, kind: "confirm" })} onCancel={(t) => act.mutate({ token: t, kind: "cancel" })} />}
                    </div>
                  </div>
                ))}
                {pending && <div className="flex justify-end"><div className="max-w-[92%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-primary-foreground">{pending}</div></div>}
                {send.isPending && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Lumi is working</div>}
                {limit && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{limit}</p>}
                <div ref={endRef} />
              </div>
              <form className="border-t p-3" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
                <div className="flex items-end gap-2">
                  <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder="For example: make my greeting friendlier" aria-label="Message to Lumi" className="min-h-12 resize-none"
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(text); } }} disabled={!id} />
                  <Button type="submit" size="icon" className="size-11 shrink-0" disabled={!text.trim() || busy || !id} aria-label="Send"><Send /></Button>
                </div>
                {alw && !status.data?.selfHosted && <p className="mt-2 text-xs text-muted-foreground" data-testid="copilot-remaining">{remainingText(alw)}</p>}
              </form>
            </>
          )}
      </SheetContent>
    </Sheet>
  );
}

/** Free and trial workspaces: the drawer opens, but shows an upgrade card instead of the chat. */
function Locked() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center" data-testid="copilot-locked">
      <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground"><Lock className="size-5" aria-hidden /></span>
      <div className="space-y-1.5"><h3 className="font-display text-lg font-semibold">Ask Lumi is included in paid plans</h3><p className="text-sm text-muted-foreground">Upgrade and Lumi can change your agent, chat window, hours and website knowledge for you, with a monthly allowance of its own that never uses your customer chat credits.</p></div>
      <Button asChild><Link to="/settings/billing">See plans</Link></Button>
    </div>
  );
}
