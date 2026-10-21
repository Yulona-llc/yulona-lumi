import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation } from "@tanstack/react-query";
import { toolManifestV2Schema } from "@yulona/shared";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, CheckCircle2, ChevronRight, FlaskConical, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { Select, TextField } from "../common/ui";
import { tl, type Connection, type FieldNode, type ToolTestResult } from "./api";
import { FieldTreeView } from "./FieldTree";
import {
  FIELD_TYPES, PLACES, autoDescription, blankField, buildManifest, humanize, placesFor, previewRequest, reconcilePath, renamePlaceholder, sampleOf, sampleValues, snake,
  toolNameFromTitle, uniqueName, defaultPlace, explainError, type FieldDraft, type FieldType, type Method, type Place, type ToolDraft,
} from "./model";

export type SetDraft = Dispatch<SetStateAction<ToolDraft>>;
interface Common { d: ToolDraft; setD: SetDraft }

const CHEVRON = { backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2354657f' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" } as const;
const Heading = ({ title, hint }: { title: string; hint?: string }) => (
  <div className="mb-4"><h3 className="font-display text-lg font-semibold leading-tight">{title}</h3>{hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}</div>
);

// ------------------------------------------------------------------ 3. What should the AI ask?
export function StepAsk({ d, setD, otherTools, editing }: Common & { otherTools: string[]; editing: boolean }) {
  const updateField = (id: string, patch: Partial<FieldDraft>) => setD((cur) => {
    const old = cur.fields.find((f) => f.id === id)!;
    const f: FieldDraft = { ...old, ...patch };
    const others = cur.fields.filter((x) => x.id !== id).map((x) => x.name);
    if ("label" in patch && !old.nameEdited) f.name = uniqueName(snake(patch.label ?? ""), others);
    if ("name" in patch) { f.name = (patch.name ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_"); f.nameEdited = true; }
    let path = cur.path;
    if (old.place === "path" && f.name !== old.name && f.name) path = renamePlaceholder(path, old.name, f.name);
    const fields = cur.fields.map((x) => (x.id === id ? f : x));
    return { ...cur, fields, path: reconcilePath(path, fields) };
  });
  const add = () => setD((cur) => ({ ...cur, fields: [...cur.fields, blankField({ label: "" }, cur.fields.map((f) => f.name), cur.method)] }));
  const remove = (id: string) => setD((cur) => { const fields = cur.fields.filter((f) => f.id !== id); return { ...cur, fields, path: reconcilePath(cur.path, fields) }; });
  const move = (i: number, dir: -1 | 1) => setD((cur) => { const fields = [...cur.fields]; const j = i + dir; if (j < 0 || j >= fields.length) return cur; [fields[i], fields[j]] = [fields[j]!, fields[i]!]; return { ...cur, fields }; });
  const auto = useMemo(() => autoDescription(d), [d]);

  return (
    <div className="space-y-5">
      <Heading title="What should the AI ask the customer?" hint="Each question becomes something the AI collects before it calls your system. Keep it to what your system really needs." />
      <TextField label="Name this tool" hint="A short name your team will recognise." value={d.title} maxLength={60}
        onChange={(e) => { const title = e.target.value; setD((cur) => ({ ...cur, title, ...(cur.nameEdited || editing ? {} : { name: toolNameFromTitle(title, otherTools) }) })); }} />
      <ul className="space-y-3" aria-label="Questions for the customer">
        <AnimatePresence initial={false}>
          {d.fields.map((f, i) => (
            <motion.li key={f.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.18 }} className="space-y-3 rounded-2xl border bg-card p-3.5 sm:p-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <TextField label="Question" value={f.label} placeholder="Order number" maxLength={60} onChange={(e) => updateField(f.id, { label: e.target.value })} aria-label={`Question ${i + 1}`} />
                <Select label="Answer type" value={f.type} onChange={(e) => updateField(f.id, { type: e.target.value as FieldType })} aria-label={`Answer type for question ${i + 1}`}>
                  {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </div>
              {f.type === "choice" && <TextField label="Choices" hint="Separate with commas." value={f.choices} placeholder="Small, Medium, Large" onChange={(e) => updateField(f.id, { choices: e.target.value })} />}
              <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <TextField label="Example answer" hint="Helps the AI and fills the test." value={f.example} maxLength={80} onChange={(e) => updateField(f.id, { example: e.target.value })} />
                <div className="flex items-center justify-between gap-3 sm:pb-6">
                  <label className="flex min-h-11 items-center gap-2 text-sm font-medium sm:min-h-9"><Switch checked={f.required} onCheckedChange={(v) => updateField(f.id, { required: v })} aria-label={`Required: ${f.label || `question ${i + 1}`}`} />Required</label>
                  <div className="flex">
                    <Button variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${f.label || "question"} up`}><ArrowUp /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => move(i, 1)} disabled={i === d.fields.length - 1} aria-label={`Move ${f.label || "question"} down`}><ArrowDown /></Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => remove(f.id)} aria-label={`Remove ${f.label || "question"}`}><Trash2 /></Button>
                  </div>
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {d.fields.length === 0 && <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">No questions. The AI will call your system without asking the customer anything.</p>}
      <Button variant="outline" onClick={add} disabled={d.fields.length >= 20}><Plus />Add a question</Button>

      <details className="group rounded-2xl border bg-muted/30">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium"><ChevronRight className="size-4 transition-transform group-open:rotate-90" />Advanced: names and what the AI is told</summary>
        <div className="space-y-4 border-t p-4">
          <TextField label="Internal tool name" hint="Lowercase letters, digits and underscores. Cannot change after saving, because the agent refers to it." value={d.name} disabled={editing}
            onChange={(e) => setD((cur) => ({ ...cur, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"), nameEdited: true }))} className="font-mono text-sm" spellCheck={false} />
          {d.fields.length > 0 && (
            <div className="space-y-2">
              <Label>Field names</Label>
              <p className="text-sm text-muted-foreground">Generated from the questions. Change them only if your developer asks.</p>
              {d.fields.map((f) => <div key={f.id} className="flex items-center gap-2"><span className="w-2/5 truncate text-sm text-muted-foreground">{f.label || "Untitled"}</span><Input value={f.name} onChange={(e) => updateField(f.id, { name: e.target.value })} className="font-mono text-sm" spellCheck={false} aria-label={`Field name for ${f.label || "question"}`} /></div>)}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="tool-desc">Description the AI reads</Label>
            <Textarea id="tool-desc" rows={5} value={d.descriptionEdited ? d.description : auto} maxLength={1000} onChange={(e) => setD((cur) => ({ ...cur, description: e.target.value, descriptionEdited: true }))} />
            <p className="text-sm text-muted-foreground">Say when to use the tool. We write it from your answers until you edit it.</p>
            {d.descriptionEdited && <Button variant="ghost" size="sm" onClick={() => setD((cur) => ({ ...cur, descriptionEdited: false, description: "" }))}>Write it for me again</Button>}
          </div>
        </div>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ 4. How is it sent?
const METHODS: Array<[Method, string]> = [["GET", "GET: read information"], ["POST", "POST: send new information"], ["PUT", "PUT: replace information"], ["PATCH", "PATCH: change part of it"], ["DELETE", "DELETE: remove information"]];

export function StepSend({ d, setD, conn }: Common & { conn?: Connection }) {
  const pv = useMemo(() => previewRequest(d, conn), [d, conn]);
  const setMethod = (m: Method) => setD((cur) => {
    const allowed = placesFor(m);
    const fields = cur.fields.map((f) => (allowed.includes(f.place) ? (f.place === defaultPlace(cur.method) ? { ...f, place: defaultPlace(m) } : f) : { ...f, place: defaultPlace(m) }));
    return { ...cur, method: m, fields, keep: { ...cur.keep, ...(m === "GET" || m === "PUT" || m === "DELETE" ? {} : { retry: undefined }), ...(m === "GET" || m === "DELETE" ? { bodyTemplate: undefined } : {}) } };
  });
  const setPlace = (id: string, place: Place) => setD((cur) => { const fields = cur.fields.map((f) => (f.id === id ? { ...f, place } : f)); return { ...cur, fields, path: reconcilePath(cur.path, fields) }; });
  return (
    <div className="space-y-5">
      <Heading title="How is it sent?" hint="This is the request the AI makes to your system. You can leave the defaults if you are unsure." />
      <div className="grid items-start gap-4 sm:grid-cols-[17rem_minmax(0,1fr)]">
        <Select label="What kind of request" value={d.method} onChange={(e) => setMethod(e.target.value as Method)}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <TextField label="Path on your system" hint={conn ? `Added after ${conn.baseUrl}. Use {{field}} to place an answer in the address.` : "Added after the connection address."} value={d.path} spellCheck={false} className="font-mono text-sm"
          onChange={(e) => setD((cur) => ({ ...cur, path: e.target.value }))} onBlur={() => setD((cur) => ({ ...cur, path: reconcilePath(cur.path, cur.fields) }))} />
      </div>
      {d.fields.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Where does each answer go?</legend>
          <ul className="divide-y rounded-2xl border bg-card">
            {d.fields.map((f) => (
              <li key={f.id} className="grid items-center gap-2 px-3.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_15rem]">
                <p className="min-w-0 truncate text-sm font-medium">{f.label || f.name}<span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{f.name}</span></p>
                <select aria-label={`Where ${f.label || f.name} goes`} value={f.place} onChange={(e) => setPlace(f.id, e.target.value as Place)} className="field appearance-none bg-[length:1rem] bg-[right_0.75rem_center] bg-no-repeat pr-9" style={CHEVRON}>
                  {placesFor(d.method).map((p) => <option key={p} value={p}>{PLACES[p]}</option>)}
                </select>
              </li>))}
          </ul>
          {(d.method === "GET" || d.method === "DELETE") && <p className="text-sm text-muted-foreground">{d.method} requests have no message body, so answers go in the address.</p>}
        </fieldset>
      )}
      <div>
        <p className="mb-1.5 text-sm font-medium">What your system will receive</p>
        <div className="overflow-hidden rounded-2xl border bg-sidebar text-sidebar-foreground" aria-label="Request preview">
          <div className="flex items-start gap-2.5 border-b border-white/10 px-4 py-3">
            <span className="mt-0.5 rounded bg-primary px-1.5 py-0.5 font-mono text-xs font-bold text-primary-foreground">{pv.method}</span>
            <code className="min-w-0 break-all font-mono text-[0.8125rem]" data-testid="preview-url">{pv.url}</code>
          </div>
          <dl className="space-y-0.5 px-4 py-3 font-mono text-xs">
            {pv.headers.map(([k, v]) => <div key={k} className="flex gap-2"><dt className="shrink-0 text-sidebar-foreground/70">{k}:</dt><dd className="break-all">{v}</dd></div>)}
          </dl>
          {pv.body && <pre className="border-t border-white/10 px-4 py-3 font-mono text-xs break-all whitespace-pre-wrap" data-testid="preview-body">{pv.body}</pre>}
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">Dots stand for your secret. It is added on our server and never reaches the AI. Angle brackets show where a customer answer goes.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 5. Test it
const prettyExcerpt = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

export function StepTest({ d, setD, conn, labels, setLabels, raw, setRaw, result, setResult }: Common & {
  conn?: Connection; labels: Record<string, string>; setLabels: Dispatch<SetStateAction<Record<string, string>>>;
  raw: Record<string, string>; setRaw: Dispatch<SetStateAction<Record<string, string>>>; result: ToolTestResult | null; setResult: (r: ToolTestResult | null) => void;
}) {
  useEffect(() => { setRaw((r) => { const n = { ...r }; for (const f of d.fields) if (n[f.name] === undefined) n[f.name] = sampleOf(f); return n; }); }, [d.fields, setRaw]);
  const [problem, setProblem] = useState<string>();
  const test = useMutation({
    meta: { skipInvalidate: true },
    mutationFn: () => {
      const m = buildManifest(d);
      const parsed = toolManifestV2Schema.safeParse(m);
      if (!parsed.success) { const i = parsed.error.issues[0]!; throw new Error(`${i.path.join(".") || "tool"}: ${i.message}`); }
      return tl.testTool(m, sampleValues(d, raw));
    },
    onMutate: () => setProblem(undefined),
    onSuccess: (r) => { setResult(r); toast[r.ok ? "success" : "error"](r.ok ? "Test worked" : "Test did not work", { description: r.ok ? `Your system answered ${r.status} in ${r.latencyMs} ms.` : explainError(r.error) }); },
    onError: (e) => { setProblem(errMsg(e)); toast.error("Fix the tool before testing", { description: errMsg(e) }); },
  });
  const mappedPaths = useMemo(() => new Set(d.mapping.map((m) => m.path)), [d.mapping]);

  const pick = (n: FieldNode) => setD((cur) => {
    if (cur.mapping.some((m) => m.path === n.path)) return { ...cur, mapping: cur.mapping.filter((m) => m.path !== n.path) };
    const key = uniqueName(snake(n.name || "item"), cur.mapping.map((m) => m.key), "value");
    setLabels((l) => ({ ...l, [n.path]: humanize(key).toLowerCase() }));
    return { ...cur, mapping: [...cur.mapping, { key, path: n.path }] };
  });
  const relabel = (path: string, text: string) => {
    setLabels((l) => ({ ...l, [path]: text }));
    setD((cur) => {
      const others = cur.mapping.filter((m) => m.path !== path).map((m) => m.key);
      const key = uniqueName(snake(text), others, "value");
      return { ...cur, mapping: cur.mapping.map((m) => (m.path === path ? { ...m, key } : m)) };
    });
  };
  const risky = d.method !== "GET";
  return (
    <div className="space-y-5">
      <Heading title="Test it" hint="Try it with sample answers. Then tap the fields you want the AI to read back to the customer." />
      {d.fields.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {d.fields.map((f) => (
            f.type === "boolean" ? (
              <Select key={f.id} label={f.label || f.name} value={raw[f.name] ?? "true"} onChange={(e) => setRaw((r) => ({ ...r, [f.name]: e.target.value }))}><option value="true">Yes</option><option value="false">No</option></Select>
            ) : f.type === "choice" ? (
              <Select key={f.id} label={f.label || f.name} value={raw[f.name] ?? ""} onChange={(e) => setRaw((r) => ({ ...r, [f.name]: e.target.value }))}>{f.choices.split(/[,\n]/).map((c) => c.trim()).filter(Boolean).map((c) => <option key={c}>{c}</option>)}</Select>
            ) : (
              <TextField key={f.id} label={`${f.label || f.name}${f.required ? "" : " (optional)"}`} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={raw[f.name] ?? ""} onChange={(e) => setRaw((r) => ({ ...r, [f.name]: e.target.value }))} />
            )))}
        </div>
      )}
      <div className="space-y-2">
        <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? <Spinner /> : <FlaskConical />}Run test</Button>
        <p className="text-sm text-muted-foreground">{risky ? `This sends a real ${d.method} to ${conn?.name ?? "your system"}. It may create or change real data.` : `This calls ${conn?.name ?? "your system"} once, for real.`}</p>
        {problem && <Alert variant="destructive"><TriangleAlert /><AlertDescription>{problem}</AlertDescription></Alert>}
      </div>

      <div aria-live="polite" className="space-y-4">
        {test.isPending && <div className="h-24 animate-pulse rounded-2xl bg-muted" aria-label="Running the test" />}
        {result && !test.isPending && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <Alert variant={result.ok ? "success" : "destructive"}>
              {result.ok ? <CheckCircle2 /> : <TriangleAlert />}
              <AlertTitle>{result.ok ? "Your system answered" : "The test did not work"}</AlertTitle>
              <AlertDescription>
                <span className="flex flex-wrap items-center gap-2">{result.status !== undefined && <Badge variant={result.ok ? "success" : "destructive"}>Status {result.status}</Badge>}{result.latencyMs !== undefined && <Badge variant="secondary">{result.latencyMs} ms</Badge>}{(result.attempts ?? 1) > 1 && <Badge variant="warning">{result.attempts} attempts</Badge>}</span>
                {!result.ok && <span className="mt-1.5 block">{explainError(result.error)}</span>}
              </AlertDescription>
            </Alert>
            {result.request && (
              <details className="rounded-xl border bg-muted/30"><summary className="min-h-11 cursor-pointer px-3.5 py-3 text-sm font-medium">What was sent (secrets hidden)</summary>
                <div className="space-y-1 border-t px-3.5 py-3 font-mono text-xs"><p className="break-all font-semibold">{result.request.method} {result.request.url}</p>{Object.entries(result.request.headers).map(([k, v]) => <p key={k} className="break-all text-muted-foreground">{k}: {v}</p>)}{result.request.body && <pre className="whitespace-pre-wrap break-all">{result.request.body}</pre>}</div></details>
            )}
            {result.response && (
              <details className="rounded-xl border bg-muted/30"><summary className="min-h-11 cursor-pointer px-3.5 py-3 text-sm font-medium">What came back{result.response.truncated ? " (shortened)" : ""}</summary>
                <pre className="max-h-64 overflow-auto border-t px-3.5 py-3 font-mono text-xs break-all whitespace-pre-wrap">{prettyExcerpt(result.response.excerpt)}</pre></details>
            )}
            {result.ok && result.fieldTree === null && <Alert variant="warning"><TriangleAlert /><AlertDescription>The answer is not JSON, so there are no fields to pick. The AI will get the text as it is.</AlertDescription></Alert>}
            {result.fieldTree && (
              <div className="rounded-2xl border bg-card p-3.5">
                <p className="mb-2 text-sm font-medium">Tap the fields the AI should read back</p>
                <FieldTreeView tree={result.fieldTree} mapped={mappedPaths} onPick={pick} />
              </div>
            )}
            {result.mapped && Object.keys(result.mapped).length > 0 && <pre className="overflow-auto rounded-xl bg-muted px-3.5 py-3 font-mono text-xs" aria-label="What the AI will read back">{JSON.stringify(result.mapped, null, 2)}</pre>}
          </motion.div>
        )}
      </div>

      <section aria-labelledby="readback" className="space-y-2">
        <h4 id="readback" className="text-sm font-medium">What the AI should read back</h4>
        {d.mapping.length === 0 ? <p className="text-sm text-muted-foreground">Nothing picked. The AI gets the whole answer (shortened to 8 KB). Pick fields to keep it focused.</p> : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {d.mapping.map((m) => (
                <motion.li key={m.path} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-xl border bg-card p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <Input value={labels[m.path] ?? m.key.replace(/_/g, " ")} onChange={(e) => relabel(m.path, e.target.value)} aria-label={`Label for ${m.path}`} />
                  <code className="col-span-2 row-start-2 truncate px-1 font-mono text-xs text-muted-foreground sm:col-span-1 sm:row-start-auto" title={m.path}>from {m.path}</code>
                  <Button variant="ghost" size="icon-sm" className="sm:col-start-3" onClick={() => setD((cur) => ({ ...cur, mapping: cur.mapping.filter((x) => x.path !== m.path) }))} aria-label={`Remove ${m.key}`}><X /></Button>
                </motion.li>))}
            </AnimatePresence>
          </ul>
        )}
      </section>
    </div>
  );
}
