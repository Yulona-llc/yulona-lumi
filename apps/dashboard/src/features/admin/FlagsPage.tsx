import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, Loading, PageHeader, TextField } from "../common/ui";
import { adminApi } from "./api";

export default function FlagsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "flags"], queryFn: adminApi.flags });
  const inv = () => void qc.invalidateQueries({ queryKey: ["admin", "flags"] });
  const set = useMutation({ mutationFn: (v: { key: string; description?: string; defaultEnabled: boolean }) => adminApi.setFlag(v.key, { ...(v.description ? { description: v.description } : {}), defaultEnabled: v.defaultEnabled }), onSuccess: () => { inv(); toast.success("Flag saved"); } });
  const del = useMutation({ mutationFn: (k: string) => adminApi.deleteFlag(k), onSuccess: () => { inv(); setDelKey(null); toast.success("Flag deleted"); } });
  const [key, setKey] = useState("");
  const [desc, setDesc] = useState("");
  const [on, setOn] = useState(false);
  const [delKey, setDelKey] = useState<string | null>(null);
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Feature flags" subtitle="Platform defaults. Per-tenant overrides live on each tenant." />
      {(set.isError || del.isError) && <Alert variant="destructive">{errMsg(set.error ?? del.error)}</Alert>}
      <Card>
        <h2 className="font-display text-lg font-semibold">New flag</h2>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) { set.mutate({ key: key.trim(), description: desc.trim(), defaultEnabled: on }); setKey(""); setDesc(""); } }}>
          <TextField label="Flag key" value={key} onChange={(e) => setKey(e.target.value)} pattern="[a-z0-9_.\-]+" maxLength={64} />
          <TextField label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <label className="flex min-h-11 items-center gap-3 text-sm"><Switch checked={on} onCheckedChange={setOn} aria-label="Enabled by default" />Enabled by default</label>
          <div className="sm:text-right"><Button className="max-sm:w-full" disabled={set.isPending || !key.trim()}>Save flag</Button></div>
        </form>
      </Card>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 ? <Empty title="No flags yet" body="Create the first flag above." /> : (
        <Card className="divide-y gap-0 p-0"><ul className="divide-y">{q.data.map((f) => (
          <li key={f.key} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0"><code className="font-mono text-sm font-medium">{f.key}</code>{f.description && <p className="text-sm text-muted-foreground">{f.description}</p>}
              <p className="mt-0.5 text-xs text-muted-foreground">{f.defaultEnabled ? "On by default" : "Off by default"}</p></div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch checked={f.defaultEnabled} aria-label={`${f.key} enabled by default`} onCheckedChange={(v) => set.mutate({ key: f.key, description: f.description ?? undefined, defaultEnabled: v })} />
              <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDelKey(f.key)}><Trash2 aria-hidden /><span className="sr-only">Delete {f.key}</span></Button>
            </div></li>))}</ul></Card>)}
      {delKey && <ConfirmModal danger title="Delete flag?" body={<>Delete <code className="font-mono">{delKey}</code>? Tenant overrides for it stop applying.</>} confirm="Delete flag" busy={del.isPending} onConfirm={() => del.mutate(delKey)} onClose={() => setDelKey(null)} />}
    </div>
  );
}
