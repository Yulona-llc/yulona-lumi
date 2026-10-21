import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, Loading } from "../common/ui";
import { MICRO } from "../usage/api";
import { adminCreditKeys, creditsAdmin, type ModelRate } from "./creditsApi";

const DEFAULT = "*";
const show = (micro: number) => String(micro / MICRO);
const toMicro = (s: string) => Math.round(Number(s) * MICRO);
const valid = (s: string) => s.trim() !== "" && Number.isFinite(Number(s)) && Number(s) >= 0;

/** Rates are stored in micro-credits per 1k tokens and edited as credits per 1k tokens. */
export default function RatesTab() {
  const q = useQuery({ queryKey: adminCreditKeys.rates, queryFn: creditsAdmin.rates });
  const [editing, setEditing] = useState<string | null>(null);
  const [inDraft, setIn] = useState(""); const [outDraft, setOut] = useState("");
  const [nm, setNm] = useState(""); const [nIn, setNIn] = useState(""); const [nOut, setNOut] = useState("");
  const [del, setDel] = useState<ModelRate | null>(null);
  const set = useMutation({
    mutationFn: (b: Parameters<typeof creditsAdmin.setRate>[0]) => creditsAdmin.setRate(b),
    onSuccess: (_r, b) => { toast.success(`Rate saved for ${b.model === DEFAULT ? "the default row" : b.model}`); setEditing(null); }, onError: (e) => toast.error(errMsg(e)),
  });
  const rm = useMutation({ mutationFn: (m: string) => creditsAdmin.deleteRate(m), onSuccess: () => { setDel(null); toast.success("Rate deleted"); }, onError: (e) => toast.error(errMsg(e)) });
  const rows = [...(q.data ?? [])].sort((a, b) => (a.model === DEFAULT ? -1 : b.model === DEFAULT ? 1 : a.model.localeCompare(b.model)));
  const start = (r: ModelRate) => { setEditing(r.model); setIn(show(r.inputMicroPer1k)); setOut(show(r.outputMicroPer1k)); };
  const grid = "sm:grid-cols-[minmax(0,1fr)_8rem_8rem_5.5rem_8.5rem]";
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">Credits charged per 1,000 tokens. A model without its own row uses the default (*) row. Cost per call rounds up to a micro-credit.</p>
      <Card className="gap-3 p-4">
        <h2 className="font-display text-lg font-semibold">Add a model rate</h2>
        <form className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (nm.trim() && valid(nIn) && valid(nOut)) { set.mutate({ model: nm.trim(), inputMicroPer1k: toMicro(nIn), outputMicroPer1k: toMicro(nOut), enabled: true }); setNm(""); setNIn(""); setNOut(""); } }}>
          <label className="col-span-2 grid gap-1.5 text-sm font-medium sm:col-span-1">Model<Input value={nm} onChange={(e) => setNm(e.target.value)} className="font-mono" maxLength={120} required /></label>
          <label className="grid gap-1.5 text-sm font-medium">Input credits per 1k<Input inputMode="decimal" value={nIn} onChange={(e) => setNIn(e.target.value)} required /></label>
          <label className="grid gap-1.5 text-sm font-medium">Output credits per 1k<Input inputMode="decimal" value={nOut} onChange={(e) => setNOut(e.target.value)} required /></label>
          <Button className="col-span-2 sm:col-span-1" disabled={set.isPending || !nm.trim() || !valid(nIn) || !valid(nOut)}><Plus aria-hidden />Add rate</Button>
        </form>
      </Card>
      {q.isPending ? <Loading label="Loading rates" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : rows.length === 0 ? <Empty title="No rates yet" body="The default row appears once the server has run its migrations." />
        : (
          <Card className="gap-0 p-0">
            <div className={`hidden gap-3 border-b px-4 py-2.5 text-sm text-muted-foreground sm:grid ${grid}`}><span>Model</span><span className="text-right">Input per 1k</span><span className="text-right">Output per 1k</span><span className="text-center">Enabled</span><span className="text-right">Actions</span></div>
            <ul className="divide-y">
              {rows.map((r) => {
                const isEdit = editing === r.model, isDef = r.model === DEFAULT;
                return (
                  <li key={r.model} className={`grid grid-cols-2 items-center gap-x-3 gap-y-2 px-4 py-3 ${grid}`}>
                    <span className="col-span-2 min-w-0 truncate sm:col-span-1">{isDef ? <span className="flex items-center gap-2 font-medium">Default (*)<Badge variant="secondary">All other models</Badge></span> : <code className="font-mono text-sm font-medium">{r.model}</code>}</span>
                    {isEdit ? (
                      <>
                        <label className="grid gap-1 text-sm sm:block"><span className="text-muted-foreground sm:sr-only">Input credits per 1k for {r.model}</span><Input inputMode="decimal" aria-label={`Input credits per 1k for ${r.model}`} value={inDraft} onChange={(e) => setIn(e.target.value)} className="sm:text-right" /></label>
                        <label className="grid gap-1 text-sm sm:block"><span className="text-muted-foreground sm:sr-only">Output credits per 1k for {r.model}</span><Input inputMode="decimal" aria-label={`Output credits per 1k for ${r.model}`} value={outDraft} onChange={(e) => setOut(e.target.value)} className="sm:text-right" /></label>
                      </>
                    ) : (
                      <>
                        <span className="text-sm tabular-nums sm:text-right"><span className="text-muted-foreground sm:hidden">Input </span>{show(r.inputMicroPer1k)}</span>
                        <span className="text-sm tabular-nums sm:text-right"><span className="text-muted-foreground sm:hidden">Output </span>{show(r.outputMicroPer1k)}</span>
                      </>
                    )}
                    <span className="flex items-center gap-2 sm:justify-center"><Switch checked={r.enabled} aria-label={`${isDef ? "Default row" : r.model} enabled`} disabled={set.isPending} onCheckedChange={(v) => set.mutate({ model: r.model, inputMicroPer1k: r.inputMicroPer1k, outputMicroPer1k: r.outputMicroPer1k, enabled: v })} /><span className="text-sm text-muted-foreground sm:hidden">Enabled</span></span>
                    <span className="flex justify-end gap-1">
                      {isEdit ? (
                        <>
                          <Button size="sm" disabled={set.isPending || !valid(inDraft) || !valid(outDraft)} onClick={() => set.mutate({ model: r.model, inputMicroPer1k: toMicro(inDraft), outputMicroPer1k: toMicro(outDraft), enabled: r.enabled })}><Check aria-hidden />Save<span className="sr-only"> rate for {r.model}</span></Button>
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(null)}><X aria-hidden /><span className="sr-only">Cancel editing {r.model}</span></Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" onClick={() => start(r)}><Pencil aria-hidden />Edit<span className="sr-only"> rate for {r.model}</span></Button>
                          {!isDef && <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => setDel(r)}><Trash2 aria-hidden /><span className="sr-only">Delete rate for {r.model}</span></Button>}
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      {del && <ConfirmModal danger title="Delete rate?" body={<><code className="font-mono">{del.model}</code> will use the default (*) rate from now on.</>} confirm="Delete rate" busy={rm.isPending} onConfirm={() => rm.mutate(del.model)} onClose={() => setDel(null)} />}
    </div>
  );
}
