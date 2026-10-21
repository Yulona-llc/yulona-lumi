import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { BookOpenCheck, Bot, CheckCircle2, RotateCcw, SendHorizontal, TriangleAlert, Wrench } from "lucide-react";
import { CONVERSION_STAGES, type ConversionStage } from "@yulona/shared";
import { ag, errMsg, type SandboxResult } from "../common/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Badge, Select } from "../common/ui";
import { cn } from "@/lib/utils";

interface Turn { role: "user" | "assistant"; content: string; result?: SandboxResult }

export function SandboxConsole({ agentId }: { agentId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [msg, setMsg] = useState("");
  const [stage, setStage] = useState<ConversionStage>("visitor");
  const [sel, setSel] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const m = useMutation({
    mutationFn: (message: string) => ag.sandbox({ agentId, message, stage, history: turns.slice(-10).map(({ role, content }) => ({ role, content })) }),
    onError: (e) => toast.error(errMsg(e)),
  });
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [turns.length, m.isPending]);
  const send = () => {
    const text = msg.trim();
    if (!text || m.isPending) return;
    setMsg("");
    setTurns((t) => [...t, { role: "user", content: text }]);
    m.mutate(text, {
      onSuccess: (r) => {
        setTurns((t) => { setSel(t.length); return [...t, { role: "assistant", content: r.answer, result: r }]; });
        setStage(r.stageAfter);
      },
    });
  };
  const r = sel !== null ? turns[sel]?.result : [...turns].reverse().find((t) => t.result)?.result;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section aria-label="Test conversation" className="flex min-h-[26rem] flex-col rounded-2xl border bg-card">
        <header className="flex items-end justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0"><h2 className="font-display text-base font-semibold">Test conversation</h2><p className="text-xs text-muted-foreground">Nothing is saved or sent to customers.</p></div>
          <div className="w-40 shrink-0"><Select label="Stage" value={stage} onChange={(e) => setStage(e.target.value as ConversionStage)}>
            {CONVERSION_STAGES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</Select></div>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 xl:max-h-[32rem]" role="log" aria-live="polite" aria-label="Sandbox transcript">
          {turns.length === 0 && (
            <div className="grid place-items-center gap-2 py-10 text-center">
              <span className="grid size-11 place-items-center rounded-2xl bg-accent text-accent-foreground"><Bot className="size-5" /></span>
              <p className="max-w-xs text-sm text-muted-foreground">Ask what a customer would ask. Then tap a reply to see which skill sections the agent read.</p>
            </div>
          )}
          <AnimatePresence initial={false}>
            {turns.map((t, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={cn("flex", t.role === "user" && "justify-end")}>
                <button type="button" disabled={!t.result} onClick={() => setSel(i)} aria-pressed={sel === i}
                  className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-left text-[0.9375rem] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    t.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : cn("rounded-bl-md bg-muted", sel === i && "ring-2 ring-primary"))}>
                  {t.content}
                  {t.result && <span className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground"><BookOpenCheck className="size-3.5" />{t.result.retrieved.length} section{t.result.retrieved.length === 1 ? "" : "s"} read</span>}
                </button>
              </motion.div>))}
          </AnimatePresence>
          {m.isPending && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Thinking…</div>}
          <div ref={end} />
        </div>
        {m.isError && <div className="px-4 pb-2"><Alert variant="destructive"><AlertDescription>{errMsg(m.error)}</AlertDescription></Alert></div>}
        <form className="flex items-center gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <Input aria-label="Message" placeholder="Type a customer message" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={2000} autoComplete="off" />
          <Button size="icon" disabled={m.isPending || !msg.trim()} aria-label="Send"><SendHorizontal /></Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Reset conversation" onClick={() => { setTurns([]); setSel(null); setStage("visitor"); }}><RotateCcw /></Button>
        </form>
      </section>

      <section aria-label="Why it answered that way" className="h-fit rounded-2xl border bg-card">
        <header className="border-b px-4 py-3"><h2 className="font-display text-base font-semibold">What the agent read</h2></header>
        {!r ? <p className="p-4 text-sm text-muted-foreground">Run a test message to see the skill sections the agent opened, stage changes and handoffs.</p> : (
          <div className="space-y-4 p-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge color="blue">{r.stageBefore.replace("_", " ")} to {r.stageAfter.replace("_", " ")}</Badge>
              <Badge color={r.guardTriggered ? "red" : "green"}>{r.guardTriggered ? "Not found in knowledge" : "Grounded"}</Badge>
            </div>
            {r.handoff && (
              <Alert variant="warning" role="status">
                <TriangleAlert />
                <AlertTitle>Handoff: {r.handoff.type}</AlertTitle>
                <AlertDescription>{r.handoff.reason}
                  {r.handoff.leadCard && <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{JSON.stringify(r.handoff.leadCard, null, 2)}</pre>}
                </AlertDescription>
              </Alert>
            )}
            <div>
              <h3 className="mb-2 font-medium">Skill sections ({r.retrieved.length})</h3>
              {r.retrieved.length === 0 ? <p className="text-muted-foreground">No skill sections were relevant.</p> : (
                <ul className="space-y-2">{r.retrieved.map((c) => (
                  <li key={c.id} className={cn("rounded-xl border p-3", c.usedForAnswer ? "border-success/40 bg-success/8" : "opacity-80")}>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5 font-medium">{c.usedForAnswer && <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label="Used for the answer" />}<span className="truncate font-mono">{c.sourceName}</span></span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{c.score >= 1 ? "pre-loaded" : `match ${c.score.toFixed(2)}`}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-4 text-muted-foreground">{c.content}</p>
                  </li>))}</ul>)}
            </div>
            {r.toolRuns.length > 0 && (
              <div><h3 className="mb-2 flex items-center gap-1.5 font-medium"><Wrench className="size-4" />Tool runs</h3>
                <ul className="space-y-1">{r.toolRuns.map((t, i) => <li key={i} className="flex justify-between gap-2"><span className="font-mono text-xs">{t.name}</span><span className={cn("text-xs tabular-nums", t.success ? "text-success" : "text-destructive")}>{t.success ? "ok" : t.error ?? "failed"} · {t.latencyMs}ms</span></li>)}</ul></div>
            )}
            {Object.keys(r.lead ?? {}).length > 0 && <div><h3 className="mb-2 font-medium">Lead captured</h3><pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono text-xs">{JSON.stringify(r.lead, null, 2)}</pre></div>}
            {r.usage && <p className="text-xs tabular-nums text-muted-foreground">Tokens: {r.usage.promptTokens} prompt, {r.usage.completionTokens} completion</p>}
          </div>
        )}
      </section>
    </div>
  );
}
