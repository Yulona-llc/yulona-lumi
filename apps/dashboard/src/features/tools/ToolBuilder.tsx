import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toolManifestV2Schema, type ToolManifestV2 } from "@yulona/shared";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Plug, Plus, Save, Sparkles, TriangleAlert, Wand2, Zap } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { ConfirmModal, TextField } from "../common/ui";
import { rememberConnectionTest, tl, toolKeys, useConnectionTests, type Connection, type ToolTestResult } from "./api";
import { ConnectionForm } from "./ConnectionForm";
import { AUTH_LABEL, STAGE_WORDS, TEMPLATES, buildManifest, draftFromManifest, draftFromTemplate, matchTemplate, problems, type Stage, type Template, type ToolDraft } from "./model";
import { StepAsk, StepSend, StepTest } from "./steps";

const STEPS = [
  { key: "start", short: "Start", title: "What should this tool do?" },
  { key: "connect", short: "Connect", title: "Which system does it talk to?" },
  { key: "ask", short: "Ask", title: "What should the AI ask the customer?" },
  { key: "send", short: "Send", title: "How is it sent?" },
  { key: "test", short: "Test", title: "Test it" },
  { key: "rules", short: "Rules", title: "When may the AI use it?" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

export interface BuilderProps {
  /** `new`, or edit/duplicate of an existing v2 manifest */
  mode: "new" | "edit" | "duplicate";
  initial?: ToolManifestV2;
  /** names of the agent's other tools (and the one being edited is excluded) */
  otherTools: string[];
  defaultConnectionId?: string;
  startAtTest?: boolean;
  onClose: () => void;
  onSave: (m: ToolManifestV2) => void;
}

function StepStart({ sentence, setSentence, picked, matched, onPick, onSuggest }: { sentence: string; setSentence: (s: string) => void; picked: string | null; matched: string | null; onPick: (t: Template) => void; onSuggest: (t: Template | null) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-display text-lg font-semibold leading-tight">What should this tool do?</h3>
        <p className="mt-1 text-sm text-muted-foreground">Pick the closest match. It fills in the next steps and you can change everything.</p>
      </div>
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); onSuggest(matchTemplate(sentence)); }}>
        <div className="min-w-0 flex-1"><TextField label="Or describe it in a sentence" placeholder="Look up where a customer's order is" value={sentence} onChange={(e) => setSentence(e.target.value)} maxLength={200} /></div>
        <Button type="submit" variant="outline" disabled={sentence.trim().length < 3}><Wand2 />Suggest</Button>
      </form>
      <div role="radiogroup" aria-label="Tool templates" className="grid gap-2.5 sm:grid-cols-2">
        {TEMPLATES.map((t) => {
          const on = picked === t.id;
          return (
            <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => onPick(t)}
              className={cn("relative flex min-h-24 flex-col items-start gap-1 rounded-2xl border bg-card p-4 text-left transition-[border-color,box-shadow,background-color] focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none", on ? "border-primary bg-accent/60 shadow-[0_0_0_1px_var(--primary)]" : "hover:border-foreground/30", t.id === "scratch" && "border-dashed sm:col-span-2")}>
              <span className="font-display font-semibold leading-tight">{t.title}</span>
              <span className="text-sm text-muted-foreground">{t.blurb}</span>
              {matched === t.id && !on && <Badge variant="info" className="mt-1"><Sparkles className="size-3" />Looks like a match</Badge>}
              {on && <span className="absolute right-3 top-3 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-3.5" /></span>}
            </button>);
        })}
      </div>
    </div>
  );
}

function StepConnect({ d, setConnection, conns }: { d: ToolDraft; setConnection: (id: string) => void; conns: ReturnType<typeof useQuery<Connection[]>> }) {
  const [creating, setCreating] = useState(false);
  const tests = useConnectionTests();
  const [testing, setTesting] = useState<string>();
  const runTest = async (c: Connection) => {
    setTesting(c.id);
    try { const r = await tl.testConnection(c.id); rememberConnectionTest(c.id, r); toast[r.ok ? "success" : "error"](r.ok ? `${c.name} answered` : `${c.name}: the test did not work`, r.ok ? { description: `Status ${r.status} in ${r.latencyMs} ms` } : undefined); }
    catch (e) { toast.error(errMsg(e)); } finally { setTesting(undefined); }
  };
  const showForm = creating || (conns.isSuccess && conns.data.length === 0);
  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-display text-lg font-semibold leading-tight">Which system does it talk to?</h3>
        <p className="mt-1 text-sm text-muted-foreground">A connection stores your system's address and how to sign in, once. Secrets are encrypted and never shown again.</p>
      </div>
      {conns.isPending ? <div className="space-y-2" aria-busy="true" aria-label="Loading connections">{[0, 1].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
        : conns.isError ? <Alert variant="destructive"><TriangleAlert /><AlertDescription>{errMsg(conns.error)} <button className="underline" onClick={() => void conns.refetch()}>Try again</button></AlertDescription></Alert>
        : (
          <>
            {conns.data.length > 0 && (
              <div role="radiogroup" aria-label="Connections" className="space-y-2">
                {conns.data.map((c) => {
                  const on = d.connectionId === c.id;
                  const last = tests.get(c.id);
                  return (
                    <div key={c.id} className={cn("flex items-center gap-2 rounded-2xl border bg-card p-1.5 pr-2.5 transition-colors", on && "border-primary bg-accent/60 shadow-[0_0_0_1px_var(--primary)]")}>
                      <button type="button" role="radio" aria-checked={on} onClick={() => { setConnection(c.id); setCreating(false); }} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 text-left focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none">
                        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{on ? <Check className="size-4" /> : <Plug className="size-4" />}</span>
                        <span className="min-w-0"><span className="block truncate font-medium">{c.name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{c.baseUrl}</span>
                          <span className="mt-1 flex flex-wrap gap-1"><Badge variant="secondary">{AUTH_LABEL[c.authType]}</Badge>{last && <Badge variant={last.result.ok ? "success" : "destructive"}>{last.result.ok ? "Test passed" : "Test failed"}</Badge>}</span></span>
                      </button>
                      <Button variant="outline" size="sm" onClick={() => void runTest(c)} disabled={testing === c.id} aria-label={`Test ${c.name}`}>{testing === c.id ? <Spinner /> : <Zap />}Test</Button>
                    </div>);
                })}
              </div>
            )}
            {!showForm && <Button variant="outline" onClick={() => setCreating(true)}><Plus />New connection</Button>}
            {showForm && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border bg-card p-4">
                <h4 className="mb-3 font-display font-semibold">New connection</h4>
                <ConnectionForm onDone={(c) => { setConnection(c.id); setCreating(false); }} onCancel={conns.data.length ? () => setCreating(false) : undefined} />
              </motion.div>
            )}
          </>
        )}
    </div>
  );
}

function StepRules({ d, setD, probs, goto }: { d: ToolDraft; setD: React.Dispatch<React.SetStateAction<ToolDraft>>; probs: ReturnType<typeof problems>; goto: (k: StepKey) => void }) {
  const toggle = (s: Stage, on: boolean) => setD((cur) => ({ ...cur, stages: on ? [...new Set([...cur.stages, s])] : cur.stages.filter((x) => x !== s) }));
  return (
    <div className="space-y-6">
      <div><h3 className="font-display text-lg font-semibold leading-tight">When may the AI use it?</h3><p className="mt-1 text-sm text-muted-foreground">The AI only sees this tool in the moments you tick.</p></div>
      <fieldset className="space-y-1">
        <legend className="sr-only">Moments when the AI may use this tool</legend>
        {STAGE_WORDS.map(([s, w]) => (
          <label key={s} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border bg-card px-3.5 text-[0.9375rem]">
            <input type="checkbox" className="size-5 accent-[var(--primary)]" checked={d.stages.includes(s)} onChange={(e) => toggle(s, e.target.checked)} />{w}
          </label>))}
      </fieldset>
      <div className="flex items-start gap-3 rounded-2xl border bg-card p-3.5">
        <Switch id="confirm-run" checked={d.confirmBeforeRun} onCheckedChange={(v) => setD((cur) => ({ ...cur, confirmBeforeRun: v }))} />
        <label htmlFor="confirm-run" className="text-sm"><span className="block font-medium">Ask the customer to confirm before it runs</span><span className="block text-muted-foreground">Good for anything that books, orders or changes something.</span></label>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-sm font-medium">If it fails</legend>
        {([["handoff", "Hand over to a person", "The conversation goes to your team with a note about what failed."], ["tell_customer", "Tell the customer and carry on", "The AI says it could not do it and keeps helping."]] as const).map(([v, l, h]) => (
          <label key={v} className={cn("flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm", d.onFailure === v && "border-primary bg-accent/60")}>
            <input type="radio" name="on-failure" className="mt-0.5 size-5 accent-[var(--primary)]" checked={d.onFailure === v} onChange={() => setD((cur) => ({ ...cur, onFailure: v }))} /><span><span className="block font-medium">{l}</span><span className="text-muted-foreground">{h}</span></span>
          </label>))}
      </fieldset>
      {probs.length > 0 ? (
        <Alert variant="warning"><TriangleAlert /><AlertDescription><span className="font-medium text-foreground">Fix before saving</span>
          <ul className="mt-1 list-disc space-y-1 pl-4">{probs.map((p, i) => <li key={i}>{p.text} <button type="button" className="underline" onClick={() => goto(p.where === "rules" ? "rules" : p.where)}>Go there</button></li>)}</ul></AlertDescription></Alert>
      ) : (
        <Alert variant="success" role="status"><Check /><AlertDescription>Ready to save. <span className="text-muted-foreground">Saving adds it to this agent's draft and switches it on. Use Save draft on the agent to keep it.</span></AlertDescription></Alert>
      )}
    </div>
  );
}

/** Full-height guided builder for one custom tool. It never talks to the agent API itself: `onSave` hands the v2 manifest to the editor. */
export function ToolBuilder({ mode, initial, otherTools, defaultConnectionId, startAtTest, onClose, onSave }: BuilderProps) {
  const editing = mode === "edit";
  const conns = useQuery({ queryKey: toolKeys.connections, queryFn: tl.connections });
  const base = useMemo<ToolDraft>(() => {
    if (initial) {
      const x = draftFromManifest(initial);
      if (mode === "duplicate") { const n = `${x.name}_copy`; return { ...x, name: n.slice(0, 60), title: `${x.title} copy`, nameEdited: false }; }
      return x;
    }
    return draftFromTemplate(TEMPLATES[TEMPLATES.length - 1]!, otherTools, defaultConnectionId ?? "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState<ToolDraft>(base);
  const [step, setStep] = useState(initial ? (startAtTest ? 4 : 1) : 0);
  const [dir, setDir] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);

  const [sentence, setSentence] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const matched = picked ? null : (matchTemplate(sentence)?.id ?? null);
  const [confirmClose, setConfirmClose] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const touched = JSON.stringify(d) !== JSON.stringify(base);
  const takenNames = otherTools;
  const probs = useMemo(() => problems(d, takenNames), [d, takenNames]);
  const conn = conns.data?.find((c) => c.id === d.connectionId);

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [step]);
  // keep the chosen connection valid once the list is known (it may have been deleted)
  useEffect(() => { if (conns.data && d.connectionId && !conns.data.some((c) => c.id === d.connectionId)) setD((cur) => ({ ...cur, connectionId: "" })); }, [conns.data, d.connectionId]);
  useEffect(() => { if (mode === "duplicate") { setD((cur) => { let n = cur.name; for (let i = 2; takenNames.includes(n); i++) n = `${cur.name.replace(/_\d+$/, "")}_${i}`; return n === cur.name ? cur : { ...cur, name: n }; }); } }, [mode, takenNames]);

  const pickTemplate = (t: Template) => {
    setPicked(t.id);
    const next = draftFromTemplate(t, otherTools, d.connectionId);
    setD(next); setResult(null); setRaw({}); setLabels({});
  };
  const suggest = (t: Template | null) => {
    if (!t) { toast("No match for that sentence. Pick one below or start from scratch."); return; }
    pickTemplate(t); toast.success(`Started from "${t.title}"`, { description: "Check each step, then save." });
  };
  const go = (n: number) => { setDir(n > step ? 1 : -1); setStep(Math.max(0, Math.min(STEPS.length - 1, n))); };
  const goKey = (k: StepKey) => go(STEPS.findIndex((s) => s.key === k));

  const key = STEPS[step]!.key;
  const stepBlock: string | null =
    key === "start" ? (picked || initial ? null : "Pick a starting point")
    : key === "connect" ? (d.connectionId ? null : "Choose a connection")
    : key === "ask" ? (probs.find((p) => p.where === "ask")?.text ?? null)
    : key === "send" ? (probs.find((p) => p.where === "send")?.text ?? null) : null;
  const last = step === STEPS.length - 1;

  const save = () => {
    const parsed = toolManifestV2Schema.safeParse(buildManifest(d));
    if (!parsed.success) { toast.error("The tool is not valid yet", { description: parsed.error.issues[0]?.message }); return; }
    onSave(parsed.data);
  };
  const requestClose = () => (touched ? setConfirmClose(true) : onClose());
  const heading = mode === "edit" ? `Edit ${d.title || d.name}` : mode === "duplicate" ? "Duplicate tool" : "New tool";

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) requestClose(); }}>
        <DialogContent className="flex h-dvh max-h-dvh flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[min(50rem,92dvh)] sm:max-h-[92dvh] sm:max-w-3xl sm:rounded-2xl sm:p-0" onInteractOutside={(e) => { if (touched) e.preventDefault(); }}>
          <DialogHeader className="shrink-0 gap-3 border-b px-4 pb-3 pt-3 sm:px-6 sm:pt-5">
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription className="sr-only">Step {step + 1} of {STEPS.length}: {STEPS[step]!.title}</DialogDescription>
            <nav aria-label="Steps">
              <ol className="flex gap-1.5">
                {STEPS.map((s, i) => {
                  const reachable = i <= step || (picked !== null || !!initial);
                  return (
                    <li key={s.key} className="min-w-0 flex-1">
                      <button type="button" disabled={!reachable} onClick={() => go(i)} aria-current={i === step ? "step" : undefined} className="group block w-full text-left outline-none disabled:cursor-not-allowed">
                        <span className="relative block h-1.5 overflow-hidden rounded-full bg-border"><motion.span className="absolute inset-y-0 left-0 rounded-full bg-primary" initial={false} animate={{ width: i <= step ? "100%" : "0%" }} transition={{ duration: 0.3 }} /></span>
                        <span className={cn("mt-1.5 hidden truncate text-xs font-medium sm:block", i === step ? "text-foreground" : "text-muted-foreground group-focus-visible:underline")}>{s.short}</span>
                      </button>
                    </li>);
                })}
              </ol>
              <p className="mt-2 text-sm font-medium sm:hidden" aria-hidden>Step {step + 1} of {STEPS.length}: {STEPS[step]!.short}</p>
            </nav>
          </DialogHeader>

          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <AnimatePresence mode="wait" initial={false} custom={dir}>
              <motion.div key={key} initial={{ opacity: 0, x: dir * 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -16 }} transition={{ duration: 0.18 }}>
                {key === "start" && <StepStart sentence={sentence} setSentence={setSentence} picked={picked} matched={matched} onPick={pickTemplate} onSuggest={suggest} />}
                {key === "connect" && <StepConnect d={d} conns={conns} setConnection={(id) => setD((cur) => ({ ...cur, connectionId: id }))} />}
                {key === "ask" && <StepAsk d={d} setD={setD} otherTools={takenNames} editing={editing} />}
                {key === "send" && <StepSend d={d} setD={setD} conn={conn} />}
                {key === "test" && <StepTest d={d} setD={setD} conn={conn} labels={labels} setLabels={setLabels} raw={raw} setRaw={setRaw} result={result} setResult={setResult} />}
                {key === "rules" && <StepRules d={d} setD={setD} probs={probs} goto={goKey} />}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            <Button variant="outline" onClick={() => (step === 0 ? requestClose() : go(step - 1))}>{step === 0 ? "Cancel" : <><ArrowLeft />Back</>}</Button>
            <p className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground" role="status">{stepBlock ?? (key === "test" && !result ? "Testing is optional but worth it" : "")}</p>
            {last
              ? <Button onClick={save} disabled={probs.length > 0}><Save />Save tool</Button>
              : <Button onClick={() => go(step + 1)} disabled={!!stepBlock}>Next<ArrowRight /></Button>}
          </footer>
        </DialogContent>
      </Dialog>
      {confirmClose && <ConfirmModal danger title="Discard this tool?" body="Your changes to this tool have not been saved." confirm="Discard" onConfirm={onClose} onClose={() => setConfirmClose(false)} />}
    </>
  );
}
