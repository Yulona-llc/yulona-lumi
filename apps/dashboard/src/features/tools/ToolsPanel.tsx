import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toolManifestSchema, type AgentConfig, type ToolManifest, type ToolManifestV2 } from "@yulona/shared";
import { AnimatePresence, motion } from "motion/react";
import { Activity, CheckCircle2, ChevronRight, Copy, FlaskConical, Pencil, Plug, Plus, Trash2, TriangleAlert, Wrench, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal, Empty, fmtDate, TextArea, useRole } from "../common/ui";
import { FormSection } from "../settings/parts";
import { tl, toolKeys, type ToolRun } from "./api";
import { ToolBuilder } from "./ToolBuilder";
import { humanize } from "./model";

type Update = (patch: Partial<AgentConfig>) => void;
const MAX_TOOLS = 20;

/** Recent runs of this agent's tools, read-only. Never shows inputs or outputs. */
export function ToolActivity({ agentId, runs }: { agentId: string; runs: ReturnType<typeof useQuery<ToolRun[]>> }) {
  void agentId;
  return (
    <FormSection title="Tool activity" description="The latest times the AI used a custom tool in real conversations. The sandbox never calls them.">
      {runs.isPending ? <div className="space-y-2" aria-busy="true" aria-label="Loading tool activity">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
        : runs.isError ? <p className="text-sm text-muted-foreground">Could not load tool activity. <button className="underline" onClick={() => void runs.refetch()}>Try again</button></p>
        : runs.data.length === 0 ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Activity className="size-4" />No tool runs yet. Once customers trigger a tool, each run shows up here.</p>
        : (
          <ul className="-my-1 divide-y" aria-label="Recent tool runs">
            {runs.data.map((r, i) => (
              <li key={`${r.createdAt}-${i}`} className="flex items-start gap-3 py-2.5">
                {r.success ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Worked" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />}
                <div className="min-w-0 flex-1"><p className="truncate font-mono text-sm">{r.name}</p>{r.error && <p className="line-clamp-2 text-xs text-destructive">{r.error}</p>}</div>
                <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground"><p>{r.latencyMs} ms</p><p>{fmtDate(r.createdAt)}</p></div>
              </li>))}
          </ul>
        )}
    </FormSection>
  );
}

type Dlg = { kind: "builder"; mode: "new" | "edit" | "duplicate"; tool?: ToolManifestV2; test?: boolean } | { kind: "delete"; name: string } | null;

/** Custom tools of an agent: list, builder, activity and the raw JSON escape hatch. Edits go to the agent's draft through `update`. */
export function CustomToolsPanel({ agentId, cfg, update, ro }: { agentId: string; cfg: AgentConfig; update: Update; ro: boolean }) {
  const { role } = useRole();
  const [dlg, setDlg] = useState<Dlg>(null);
  const conns = useQuery({ queryKey: toolKeys.connections, queryFn: tl.connections, enabled: !ro });
  const runs = useQuery({ queryKey: toolKeys.runs(agentId, 50), queryFn: () => tl.runs(agentId, 50), enabled: role !== "viewer" });
  const connName = (id: string) => conns.data?.find((c) => c.id === id)?.name;
  const lastUsed = useMemo(() => { const m = new Map<string, string>(); for (const r of runs.data ?? []) if (!m.has(r.name)) m.set(r.name, r.createdAt); return m; }, [runs.data]);
  const names = cfg.customTools.map((t) => t.name);
  const on = (n: string) => cfg.enabledTools.includes(n);

  const setOn = (n: string, v: boolean) => update({ enabledTools: v ? [...new Set([...cfg.enabledTools, n])] : cfg.enabledTools.filter((x) => x !== n) });
  const saveTool = (m: ToolManifestV2, mode: "new" | "edit" | "duplicate", prev?: string) => {
    const tools: ToolManifest[] = mode === "edit" ? cfg.customTools.map((t) => (t.name === prev ? m : t)) : [...cfg.customTools, m];
    update({ customTools: tools, ...(mode === "edit" ? {} : { enabledTools: [...new Set([...cfg.enabledTools, m.name])] }) });
    setDlg(null);
    toast.success(mode === "edit" ? "Tool updated in the draft" : "Tool added to the draft", { description: "Save the draft to keep it, then publish." });
  };
  const remove = (n: string) => { update({ customTools: cfg.customTools.filter((t) => t.name !== n), enabledTools: cfg.enabledTools.filter((x) => x !== n) }); setDlg(null); toast.success("Tool deleted from the draft", { description: "Save the draft to keep this." }); };

  // advanced: raw JSON
  const pretty = useMemo(() => JSON.stringify(cfg.customTools, null, 2), [cfg.customTools]);
  const [json, setJson] = useState(pretty);
  const [jsonErr, setJsonErr] = useState<string>();
  useEffect(() => { setJson(pretty); setJsonErr(undefined); }, [pretty]);
  const applyJson = () => {
    try {
      const r = toolManifestSchema.array().max(MAX_TOOLS).safeParse(JSON.parse(json));
      if (!r.success) { const i = r.error.issues[0]; setJsonErr(i ? `${i.path.join(".")}: ${i.message}` : "Invalid manifest"); return; }
      setJsonErr(undefined); update({ customTools: r.data });
      toast.success(`${r.data.length} custom tool${r.data.length === 1 ? "" : "s"} applied to the draft`);
    } catch { setJsonErr("Not valid JSON"); }
  };

  return (
    <div className="space-y-5">
      <FormSection title="Custom tools" description="Let the AI use your own systems: check stock, book appointments, look up orders. Runs on our server, logged, and secrets stay hidden."
        aside={!ro && <Button size="sm" onClick={() => setDlg({ kind: "builder", mode: "new" })} disabled={cfg.customTools.length >= MAX_TOOLS}><Plus />New tool</Button>}>
        {cfg.customTools.length === 0 ? (
          <Empty icon={<Wrench className="size-6" />} title="No custom tools yet" body="Pick a template, connect your system and test it. No code needed." action={!ro ? <Button onClick={() => setDlg({ kind: "builder", mode: "new" })}><Plus />Build your first tool</Button> : undefined} />
        ) : (
          <ul className="-mx-1 space-y-2.5">
            <AnimatePresence initial={false}>
              {cfg.customTools.map((t) => {
                const v2 = t.version === 2;
                const used = lastUsed.get(t.name);
                return (
                  <motion.li key={t.name} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2 }} className="space-y-3 rounded-2xl border bg-background p-3.5">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-display font-semibold leading-tight">{humanize(t.name)}</p>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">{t.name}</p>
                        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{t.description}</p>
                      </div>
                      <label className="flex shrink-0 items-center gap-2 text-sm font-medium"><span className="sr-only">Enable {t.name}</span><Switch checked={on(t.name)} onCheckedChange={(v) => setOn(t.name, v)} disabled={ro} aria-label={`Enable ${humanize(t.name)}`} /></label>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={on(t.name) ? "success" : "secondary"}>{on(t.name) ? "On" : "Off"}</Badge>
                      {v2 ? <Badge variant="outline"><Plug className="size-3" />{connName(t.connectionId) ?? (conns.isPending ? "…" : "Connection missing")}</Badge> : <Badge variant="warning">Older format</Badge>}
                      {v2 && t.confirmBeforeRun && <Badge variant="outline">Asks to confirm</Badge>}
                      <span className="text-xs text-muted-foreground">{used ? `Last used ${fmtDate(used)}` : "No runs yet"}</span>
                    </div>
                    {!ro && (
                      <div className="flex flex-wrap gap-2">
                        {v2 ? <>
                          <Button variant="outline" size="sm" onClick={() => setDlg({ kind: "builder", mode: "edit", tool: t })}><Pencil />Edit</Button>
                          <Button variant="outline" size="sm" onClick={() => setDlg({ kind: "builder", mode: "edit", tool: t, test: true })} aria-label={`Test ${humanize(t.name)}`}><FlaskConical />Test</Button>
                          <Button variant="outline" size="sm" onClick={() => setDlg({ kind: "builder", mode: "duplicate", tool: t })}><Copy />Duplicate</Button>
                        </> : <p className="self-center text-xs text-muted-foreground">Edit this one in the JSON below.</p>}
                        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDlg({ kind: "delete", name: t.name })}><Trash2 />Delete</Button>
                      </div>
                    )}
                  </motion.li>);
              })}
            </AnimatePresence>
          </ul>
        )}
        <p className="text-sm text-muted-foreground">Changes here go into the draft. Use <span className="font-medium text-foreground">Save draft</span> to keep them. <Link to="/settings/connections" className="font-medium text-accent-foreground underline underline-offset-4">Manage connections</Link></p>
        <details className="group rounded-xl border bg-muted/30">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-sm font-medium"><ChevronRight className="size-4 transition-transform group-open:rotate-90" />Advanced: edit manifest JSON</summary>
          <div className="space-y-3 border-t p-3.5">
            <TextArea label="Manifests (JSON array)" rows={12} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} disabled={ro} spellCheck={false} error={jsonErr} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{cfg.customTools.length} custom tool(s) in draft. Names must also be switched on above.</p>
              <Button variant="outline" onClick={applyJson} disabled={ro}>Validate and apply</Button>
            </div>
          </div>
        </details>
      </FormSection>
      {role !== "viewer" && <ToolActivity agentId={agentId} runs={runs} />}
      {role === "viewer" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><TriangleAlert className="size-4" />Tool activity is visible to agents, admins and owners.</p>}

      {dlg?.kind === "builder" && (
        <ToolBuilder mode={dlg.mode} initial={dlg.tool} startAtTest={dlg.test} otherTools={dlg.mode === "edit" ? names.filter((n) => n !== dlg.tool?.name) : names}
          defaultConnectionId={conns.data?.length === 1 ? conns.data[0]!.id : undefined}
          onClose={() => setDlg(null)} onSave={(m) => saveTool(m, dlg.mode, dlg.tool?.name)} />
      )}
      {dlg?.kind === "delete" && <ConfirmModal danger title={`Delete ${humanize(dlg.name)}?`} confirm="Delete tool" body="The AI stops using it as soon as you save and publish the draft. Its connection is kept." onConfirm={() => remove(dlg.name)} onClose={() => setDlg(null)} />}
    </div>
  );
}
