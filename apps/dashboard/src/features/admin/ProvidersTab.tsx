import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2, Pencil, Plus, Plug, Trash2, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, Loading, Modal, Select, TextArea, TextField } from "../common/ui";
import { adminCreditKeys, creditsAdmin, type LlmProfile, type ProfileInput, type TestResult } from "./creditsApi";

type Pairs = Array<[string, string]>;
const toPairs = (o: Record<string, string> | undefined): Pairs => Object.entries(o ?? {});
const fromPairs = (p: Pairs) => Object.fromEntries(p.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));

function KvEditor({ label, hint, pairs, onChange, keyLabel = "Name", valueLabel = "Value" }: { label: string; hint?: string; pairs: Pairs; onChange: (p: Pairs) => void; keyLabel?: string; valueLabel?: string }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {pairs.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input aria-label={`${label} ${keyLabel.toLowerCase()} ${i + 1}`} placeholder={keyLabel} value={k} onChange={(e) => onChange(pairs.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} className="font-mono" />
          <Input aria-label={`${label} ${valueLabel.toLowerCase()} ${i + 1}`} placeholder={valueLabel} value={v} onChange={(e) => onChange(pairs.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} className="font-mono" />
          <Button type="button" variant="ghost" size="icon" onClick={() => onChange(pairs.filter((_, j) => j !== i))}><X aria-hidden /><span className="sr-only">Remove {label.toLowerCase()} row {i + 1}</span></Button>
        </div>
      ))}
      <div><Button type="button" variant="outline" size="sm" onClick={() => onChange([...pairs, ["", ""]])}><Plus aria-hidden />Add {keyLabel.toLowerCase()}</Button></div>
    </fieldset>
  );
}

export function TestResultView({ r }: { r: TestResult }) {
  return r.ok
    ? <Alert variant="success" role="status"><CheckCircle2 /><div><p className="font-semibold">Connected</p><p className="text-muted-foreground">Model {r.model ?? "unknown"} answered in {r.latencyMs} ms.</p></div></Alert>
    : <Alert variant="destructive"><X /><div><p className="font-semibold">Connection failed</p><p className="break-words text-muted-foreground">{r.error ?? "The provider did not answer."}{r.latencyMs ? ` (${r.latencyMs} ms)` : ""}</p></div></Alert>;
}

function ProfileForm({ profile, onClose }: { profile: LlmProfile | null; onClose: () => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? "https://api.openai.com/v1");
  const [defaultModel, setDefaultModel] = useState(profile?.defaultModel ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [authHeader, setAuthHeader] = useState(profile?.authHeader ?? "Authorization");
  const [authScheme, setAuthScheme] = useState<string>(profile?.authScheme ?? "bearer");
  const [chatPath, setChatPath] = useState(profile?.chatPath ?? "/chat/completions");
  const [models, setModels] = useState((profile?.enabledModels ?? []).join("\n"));
  const [extra, setExtra] = useState<Pairs>(toPairs(profile?.extraHeaders));
  const [query, setQuery] = useState<Pairs>(toPairs(profile?.queryParams));
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [testModel, setTestModel] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body: ProfileInput = {
        name: name.trim(), baseUrl: baseUrl.trim(), defaultModel: defaultModel.trim(), authHeader: authHeader.trim() || "Authorization", authScheme,
        chatPath: chatPath.trim() || "/chat/completions", extraHeaders: fromPairs(extra), queryParams: fromPairs(query),
        enabledModels: models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean), isDefault, enabled,
      };
      if (clearKey) body.apiKey = null; else if (apiKey) body.apiKey = apiKey;
      return profile ? creditsAdmin.updateProfile(profile.id, body) : creditsAdmin.createProfile(body);
    },
    onSuccess: () => { toast.success(profile ? "Provider saved" : "Provider created"); onClose(); },
  });
  const test = useMutation({
    mutationFn: () => creditsAdmin.testProfile(profile!.id, testModel.trim() || undefined),
    onSuccess: setResult, onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Modal wide title={profile ? `Edit ${profile.name}` : "Add provider"} description="Any OpenAI-compatible chat completions service." onClose={onClose}>
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.isError && <Alert variant="destructive">{errMsg(save.error)}</Alert>}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <TextField label="Default model" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} required className="font-mono" />
          <div className="sm:col-span-2"><TextField label="Base URL" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required className="font-mono" hint="Must be https. Private and loopback hosts are refused." /></div>
          <div className="sm:col-span-2">
            <TextField label="API key" type="password" autoComplete="off" value={apiKey} onChange={(e) => { setApiKey(e.target.value); if (e.target.value) setClearKey(false); }} disabled={clearKey}
              placeholder={profile?.hasCredentials ? "Saved. Type to replace" : "Paste the key"} hint="Write only: it is encrypted and never shown again." />
            {profile?.hasCredentials && <label className="mt-2 flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} className="size-4 accent-[var(--primary)]" />Remove the saved key</label>}
          </div>
          <TextField label="Auth header" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} className="font-mono" />
          <Select label="Auth scheme" value={authScheme} onChange={(e) => setAuthScheme(e.target.value)}>
            <option value="bearer">Bearer token</option><option value="raw">Raw key (for example api-key)</option><option value="none">None</option>
          </Select>
          <TextField label="Chat path" value={chatPath} onChange={(e) => setChatPath(e.target.value)} pattern="/.*" className="font-mono" />
          <TextArea label="Enabled models" value={models} onChange={(e) => setModels(e.target.value)} rows={3} className="font-mono" hint="One per line. Agents may only choose these; anything else falls back to the default model." />
        </div>
        <KvEditor label="Extra headers" hint="Not secret: stored and shown in the clear." pairs={extra} onChange={setExtra} keyLabel="Header" />
        <KvEditor label="Query parameters" hint="Added to every request, for example api-version on Azure." pairs={query} onChange={setQuery} keyLabel="Parameter" />
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <label className="flex min-h-11 items-center gap-3 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />Enabled</label>
          <label className="flex min-h-11 items-center gap-3 text-sm"><Switch checked={isDefault} onCheckedChange={setIsDefault} aria-label="Use as default provider" />Use as default provider</label>
        </div>
        {profile && (
          <div className="space-y-3 rounded-xl border bg-muted/40 p-4">
            <p className="text-sm text-muted-foreground">Sends a tiny prompt with the saved settings. Save first to test changes.</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1"><TextField label="Model to test (optional)" value={testModel} onChange={(e) => setTestModel(e.target.value)} className="font-mono" /></div>
              <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Plug aria-hidden />}Test connection</Button>
            </div>
            {result && <TestResultView r={result} />}
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" aria-hidden />}{profile ? "Save provider" : "Create provider"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function ProvidersTab() {
  const q = useQuery({ queryKey: adminCreditKeys.profiles, queryFn: creditsAdmin.profiles });
  const [edit, setEdit] = useState<LlmProfile | "new" | null>(null);
  const [del, setDel] = useState<LlmProfile | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const test = useMutation({
    mutationFn: (p: LlmProfile) => creditsAdmin.testProfile(p.id).then((r) => [p.id, r] as const),
    onSuccess: ([id, r]) => setResults((m) => ({ ...m, [id]: r })), onError: (e) => toast.error(errMsg(e)),
  });
  const rm = useMutation({ mutationFn: (p: LlmProfile) => creditsAdmin.deleteProfile(p.id), onSuccess: () => { setDel(null); toast.success("Provider deleted"); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">The default enabled provider answers every workspace on the managed service. With none, the server falls back to its environment settings.</p>
        <Button onClick={() => setEdit("new")}><Plus aria-hidden />Add provider</Button>
      </div>
      {q.isPending ? <Loading label="Loading providers" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No providers yet" body="Add an OpenAI-compatible provider, or leave this empty to use the server's environment settings." action={<Button onClick={() => setEdit("new")}><Plus aria-hidden />Add provider</Button>} />
        : (
          <ul className="space-y-3">
            {q.data.map((p) => (
              <li key={p.id}>
                <Card className="gap-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold">{p.name}
                        {p.isDefault && <Badge>Default</Badge>}{!p.enabled && <Badge variant="secondary">Disabled</Badge>}
                        <Badge variant={p.hasCredentials ? "success" : "warning"}><KeyRound className="size-3" aria-hidden />{p.hasCredentials ? "Key saved" : "No key"}</Badge></p>
                      <p className="mt-1 break-all font-mono text-sm text-muted-foreground">{p.baseUrl}{p.chatPath}</p>
                      <p className="mt-1 text-sm text-muted-foreground">Default model <span className="font-mono text-foreground">{p.defaultModel}</span>. {p.enabledModels.length} enabled {p.enabledModels.length === 1 ? "model" : "models"}.</p>
                    </div>
                    <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
                      <Button variant="outline" size="sm" disabled={test.isPending && test.variables?.id === p.id} onClick={() => test.mutate(p)}>
                        {test.isPending && test.variables?.id === p.id ? <Loader2 className="animate-spin" aria-hidden /> : <Plug aria-hidden />}Test connection<span className="sr-only"> for {p.name}</span></Button>
                      <Button variant="outline" size="sm" onClick={() => setEdit(p)}><Pencil aria-hidden />Edit<span className="sr-only"> {p.name}</span></Button>
                      <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setDel(p)}><Trash2 aria-hidden /><span className="sr-only">Delete {p.name}</span></Button>
                    </div>
                  </div>
                  {results[p.id] && <TestResultView r={results[p.id]!} />}
                </Card>
              </li>
            ))}
          </ul>
        )}
      {edit && <ProfileForm profile={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {del && <ConfirmModal danger title="Delete provider?" body={<>Delete <strong>{del.name}</strong>? Workspaces fall back to the next default provider, or to environment settings.</>} confirm="Delete provider" busy={rm.isPending} onConfirm={() => rm.mutate(del)} onClose={() => setDel(null)} />}
    </div>
  );
}
