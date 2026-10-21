import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, KeyRound, MessageSquareText, Save } from "lucide-react";
import { allowedDomainSchema, type PrechatConfig, type WidgetConfig, type WidgetDto } from "@yulona/shared";
import { ag, errMsg } from "../common/api";
import { apiBase } from "../../config";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Badge, ConfirmModal, Empty, ErrorState, Loading, PageHeader, RoleNotice, Select, TextArea, TextField, useRole } from "../common/ui";
import { CopyButton, DirtyDot, FormSection, StickyBar, useMediaQuery } from "../settings/parts";
import { DraftCard, LiveFrame, previewDoc } from "./WidgetPreview";

export default function WidgetConfigPage() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["widgets"], queryFn: ag.widgets });
  const create = useMutation({
    mutationFn: () => ag.createWidget({ name: "Website chat" }),
    onSuccess: () => { toast.success("Widget created"); void qc.invalidateQueries({ queryKey: ["widgets"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const w = q.data[0];
  if (!w) return (
    <div><PageHeader title="Widget" />
      <Empty icon={<MessageSquareText className="size-6" />} title="No widget yet" body="Create a website chat widget, then paste the embed code on your site." action={isAdmin ? <Button onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending && <Spinner />}Create widget</Button> : undefined} /></div>
  );
  return <WidgetForm key={w.id} w={w} />;
}

const PRE_FIELDS = ["name", "email", "phone"] as const;
const clean = (c: WidgetConfig): WidgetConfig => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== "" && v !== undefined)) as WidgetConfig;

function ToggleRow({ id, title, hint, checked, onChange, disabled }: { id: string; title: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer"><span className="block font-medium">{title}</span>{hint && <span className="block text-sm text-muted-foreground">{hint}</span>}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function WidgetForm({ w }: { w: WidgetDto }) {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: ag.agents });
  const embed = useQuery({ queryKey: ["embed", w.id, w.widgetKey], queryFn: () => ag.embed(w.id) });
  const [name, setName] = useState(w.name);
  const [enabled, setEnabled] = useState(w.enabled);
  const [agentId, setAgentId] = useState(w.agentId ?? "");
  const [cfg, setCfg] = useState<WidgetConfig>(w.config);
  const [pre, setPre] = useState<PrechatConfig>(w.prechat);
  const [domains, setDomains] = useState(w.allowedDomains.join("\n"));
  const [rot, setRot] = useState(false);
  const [preview, setPreview] = useState(false);
  const [bump, setBump] = useState(0);
  const side = useMediaQuery("(min-width: 768px)");
  useEffect(() => { setName(w.name); setEnabled(w.enabled); setAgentId(w.agentId ?? ""); setCfg(w.config); setPre(w.prechat); setDomains(w.allowedDomains.join("\n")); }, [w]);

  const list = domains.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const badDomain = list.find((d) => !allowedDomainSchema.safeParse(d).success);
  const colorBad = cfg.primaryColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(cfg.primaryColor);
  const avatarBad = !!cfg.avatarUrl && !/^https:\/\//.test(cfg.avatarUrl);
  const invalid = !!badDomain || colorBad || avatarBad || !name.trim() || list.length > 50;
  const dirty = useMemo(
    () => name !== w.name || enabled !== w.enabled || agentId !== (w.agentId ?? "") || JSON.stringify(clean(cfg)) !== JSON.stringify(clean(w.config)) || JSON.stringify(pre) !== JSON.stringify(w.prechat) || JSON.stringify(list) !== JSON.stringify(w.allowedDomains),
    [name, enabled, agentId, cfg, pre, list, w],
  );
  const save = useMutation({
    mutationFn: () => ag.updateWidget(w.id, { name: name.trim(), enabled, agentId: agentId || null, config: clean(cfg), prechat: pre, allowedDomains: list }),
    onSuccess: (r) => { qc.setQueryData(["widgets"], (old: WidgetDto[] | undefined) => old?.map((x) => (x.id === r.id ? r : x))); setBump((b) => b + 1); toast.success("Widget saved"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rotate = useMutation({
    mutationFn: () => ag.rotateKey(w.id),
    onSuccess: () => { setRot(false); toast.success("Key rotated. Update the snippet on your site."); void qc.invalidateQueries({ queryKey: ["widgets"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const ro = !isAdmin;
  const set = <K extends keyof WidgetConfig>(k: K, v: WidgetConfig[K] | "") => setCfg((c) => ({ ...c, [k]: v === "" ? undefined : v }));
  const setField = (n: (typeof PRE_FIELDS)[number], on: boolean) =>
    setPre((p) => ({ ...p, fields: on ? [...p.fields, { name: n, label: n[0]!.toUpperCase() + n.slice(1), required: false }] : p.fields.filter((f) => f.name !== n) }));
  const discard = () => { setName(w.name); setEnabled(w.enabled); setAgentId(w.agentId ?? ""); setCfg(w.config); setPre(w.prechat); setDomains(w.allowedDomains.join("\n")); };

  const liveProps = (() => {
    if (!embed.data) return null;
    const o = { widgetKey: embed.data.widgetKey, apiBase: embed.data.apiUrl ? `${embed.data.apiUrl.replace(/\/+$/, "")}`.replace(/\/api\/v1$/, "") + "/api/v1" : apiBase(), scriptUrl: embed.data.scriptUrl };
    return { doc: previewDoc(o), opts: o };
  })();

  const aside: ReactNode = (
    <div className="space-y-5 2xl:sticky 2xl:top-4">
      <FormSection title="Draft preview" description="Updates as you type. Not saved yet." className="max-2xl:hidden"><DraftCard cfg={cfg} prechatEnabled={pre.enabled} /></FormSection>
      <FormSection title="Embed code" description="Paste before the closing body tag on your site.">
        {embed.data ? <>
          <pre className="overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-xs" tabIndex={0} aria-label="Embed snippet">{embed.data.snippet}</pre>
          <div className="flex flex-wrap gap-2"><CopyButton text={embed.data.snippet} label="Copy snippet" what="Snippet copied" size="default" />
            {isAdmin && <Button variant="outline" className="text-destructive" onClick={() => setRot(true)}><KeyRound />Rotate key</Button>}</div></> : embed.isError ? <ErrorState error={embed.error} retry={() => void embed.refetch()} /> : <Loading rows={2} />}
      </FormSection>
      <FormSection title="Live widget" description="Runs the real widget with the saved config." aside={<Badge>saved config</Badge>}>
        {liveProps ? <LiveFrame key={bump} {...liveProps} /> : embed.isError ? <ErrorState error={embed.error} retry={() => void embed.refetch()} /> : <Loading rows={2} />}
        <p className="text-xs text-muted-foreground">This dashboard's origin must be in the allowed domains (localhost is always allowed in development).</p>
      </FormSection>
    </div>
  );

  return (
    <div>
      <PageHeader title="Website widget" subtitle="Branding, allowed domains, pre-chat form and embed code." />
      {ro && <RoleNotice what="editing the widget" />}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-5">
          <FormSection title="Branding" description="What visitors see in the chat window.">
            <TextField label="Widget name (internal)" value={name} onChange={(e) => setName(e.target.value)} disabled={ro} maxLength={100} />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Title" value={cfg.title ?? ""} onChange={(e) => set("title", e.target.value)} disabled={ro} maxLength={60} />
              <TextField label="Subtitle" value={cfg.subtitle ?? ""} onChange={(e) => set("subtitle", e.target.value)} disabled={ro} maxLength={120} />
              <div className="grid gap-1.5">
                <TextField label="Primary color" value={cfg.primaryColor ?? ""} placeholder="#f97316" onChange={(e) => set("primaryColor", e.target.value)} disabled={ro} error={colorBad ? "Use a 6-digit hex color like #f97316" : undefined} />
              </div>
              <TextField label="Launcher label" value={cfg.launcherLabel ?? ""} onChange={(e) => set("launcherLabel", e.target.value)} disabled={ro} maxLength={40} />
              <Select label="Theme" value={cfg.theme ?? "auto"} onChange={(e) => set("theme", e.target.value as WidgetConfig["theme"])} disabled={ro}><option value="auto">Match visitor</option><option value="light">Light</option><option value="dark">Dark</option></Select>
              <Select label="Position" value={cfg.position ?? "right"} onChange={(e) => set("position", e.target.value as WidgetConfig["position"])} disabled={ro}><option value="right">Bottom right</option><option value="left">Bottom left</option></Select>
              <TextField label="Avatar image URL" type="url" value={cfg.avatarUrl ?? ""} onChange={(e) => set("avatarUrl", e.target.value)} disabled={ro} error={avatarBad ? "Must be an https URL" : undefined} />
              <TextField label="Input placeholder" value={cfg.inputPlaceholder ?? ""} onChange={(e) => set("inputPlaceholder", e.target.value)} disabled={ro} maxLength={80} />
            </div>
            <TextArea label="Welcome message" rows={2} value={cfg.welcomeMessage ?? ""} onChange={(e) => set("welcomeMessage", e.target.value)} disabled={ro} maxLength={500} />
          </FormSection>
          <FormSection title="Behaviour" description="Who answers, and whether the widget is on.">
            <Select label="Answering agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={ro} hint="Default is your oldest agent."><option value="">Default agent</option>{(agents.data ?? []).filter((a) => a.status !== "archived").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
            <ToggleRow id="w-enabled" title="Widget enabled" hint="Turn off to hide the chat on every site." checked={enabled} onChange={setEnabled} disabled={ro} />
          </FormSection>
          <FormSection title="Allowed domains" description="Only these sites can show the widget.">
            <TextArea label="One per line" hint="Examples: example.com, *.example.com (subdomains only), https://app.example.com:8443. An empty list blocks every site." rows={4} value={domains} onChange={(e) => setDomains(e.target.value)} disabled={ro} spellCheck={false}
              error={badDomain ? `Invalid domain pattern: ${badDomain}` : undefined} />
          </FormSection>
          <FormSection title="Pre-chat form" description="Collect details before the conversation starts.">
            <ToggleRow id="w-pre" title="Ask visitors for details before chatting" checked={pre.enabled} onChange={(v) => setPre({ ...pre, enabled: v })} disabled={ro} />
            {pre.enabled && <>
              <TextField label="Intro text" value={pre.intro ?? ""} onChange={(e) => setPre({ ...pre, intro: e.target.value || undefined })} disabled={ro} maxLength={300} />
              <fieldset><legend className="mb-1 text-sm font-medium">Fields</legend>
                <ul className="divide-y rounded-xl border">
                  {PRE_FIELDS.map((n) => { const f = pre.fields.find((x) => x.name === n); return (
                    <li key={n} className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 px-3 py-1.5">
                      <label className="flex min-h-9 cursor-pointer items-center gap-3 text-sm capitalize"><Checkbox checked={!!f} onCheckedChange={(v) => setField(n, v === true)} disabled={ro} />{n}</label>
                      {f && <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-muted-foreground"><Checkbox checked={f.required} onCheckedChange={(v) => setPre({ ...pre, fields: pre.fields.map((x) => (x.name === n ? { ...x, required: v === true } : x)) })} disabled={ro} />required</label>}
                    </li>); })}
                </ul>
              </fieldset></>}
          </FormSection>
        </div>
        {aside}
      </div>

      {isAdmin && (
        <StickyBar show={dirty}>
          <DirtyDot />
          <Button variant="ghost" className="2xl:hidden" onClick={() => setPreview(true)}><Eye />Preview</Button>
          <Button variant="ghost" onClick={discard} className="max-sm:hidden">Discard</Button>
          <Button disabled={save.isPending || invalid} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Save />}Save changes</Button>
        </StickyBar>
      )}
      <Sheet open={preview} onOpenChange={setPreview}>
        <SheetContent side={side ? "right" : "bottom"} className="gap-0">
          <SheetHeader><SheetTitle>Draft preview</SheetTitle><SheetDescription>Updates as you type. Not saved yet.</SheetDescription></SheetHeader>
          <div className="overflow-y-auto px-4 pb-4"><DraftCard cfg={cfg} prechatEnabled={pre.enabled} /></div>
        </SheetContent>
      </Sheet>
      {rot && <ConfirmModal danger title="Rotate the widget key?" body="The old key stops working immediately. Update the snippet on every site that embeds the widget." confirm="Rotate key" busy={rotate.isPending} onConfirm={() => rotate.mutate()} onClose={() => setRot(false)} />}
    </div>
  );
}
