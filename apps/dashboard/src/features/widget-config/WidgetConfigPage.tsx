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
import { Advanced, ChipInput } from "../common/inputs";
import { AppearanceFields, AvatarField, useAvatarCache } from "./Appearance";
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
  const [domains, setDomains] = useState<string[]>(w.allowedDomains);
  const [rot, setRot] = useState(false);
  // Cloudflare Turnstile secret key: write-only (never returned by the API)
  const [tsSecret, setTsSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [preview, setPreview] = useState(false);
  const [bump, setBump] = useState(0);
  const side = useMediaQuery("(min-width: 768px)");
  useEffect(() => { setName(w.name); setEnabled(w.enabled); setAgentId(w.agentId ?? ""); setCfg(w.config); setPre(w.prechat); setDomains(w.allowedDomains); }, [w.id, w.updatedAt]); // not on avatar changes: those save on their own and must not discard unsaved edits

  const list = domains;
  const badDomain = list.find((d) => !allowedDomainSchema.safeParse(d).success);
  const avatarCache = useAvatarCache();
  const avatarQ = useQuery({ queryKey: ["widget-avatar", w.id, w.avatarVersion], queryFn: () => ag.avatarUrl(w.id), enabled: w.hasAvatar, staleTime: Infinity, gcTime: 0 });
  const avatarBad = !!cfg.avatarUrl && !/^https:\/\//.test(cfg.avatarUrl);
  const ts = cfg.protection?.turnstile;
  const honeypot = cfg.protection?.honeypot !== false;
  const hasSecret = w.hasTurnstileSecret && !clearSecret;
  const tsBad = !!ts?.enabled && (!ts.siteKey.trim() || (!hasSecret && tsSecret.trim().length < 8));
  const invalid = !!badDomain || avatarBad || !name.trim() || list.length > 50 || tsBad;
  const dirty = useMemo(
    () => name !== w.name || enabled !== w.enabled || agentId !== (w.agentId ?? "") || JSON.stringify(clean(cfg)) !== JSON.stringify(clean(w.config)) || JSON.stringify(pre) !== JSON.stringify(w.prechat) || JSON.stringify(list) !== JSON.stringify(w.allowedDomains) || tsSecret !== "" || clearSecret,
    [name, enabled, agentId, cfg, pre, list, w, tsSecret, clearSecret],
  );
  const save = useMutation({
    mutationFn: () => ag.updateWidget(w.id, { name: name.trim(), enabled, agentId: agentId || null, config: clean(cfg), prechat: pre, allowedDomains: list, ...(tsSecret.trim() ? { turnstileSecret: tsSecret.trim() } : clearSecret ? { turnstileSecret: null } : {}) }),
    onSuccess: (r) => { setTsSecret(""); setClearSecret(false); qc.setQueryData(["widgets"], (old: WidgetDto[] | undefined) => old?.map((x) => (x.id === r.id ? r : x))); setBump((b) => b + 1); toast.success("Widget saved"); },
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
  const setProt = (p: Partial<NonNullable<WidgetConfig["protection"]>>) => setCfg((c) => ({ ...c, protection: { honeypot: true, ...c.protection, ...p } }));
  const setTs = (p: Partial<NonNullable<NonNullable<WidgetConfig["protection"]>["turnstile"]>>) =>
    setProt({ turnstile: { enabled: false, siteKey: "", theme: "auto", size: "normal", appearance: "always", ...ts, ...p } });
  const discard = () => { setTsSecret(""); setClearSecret(false); setName(w.name); setEnabled(w.enabled); setAgentId(w.agentId ?? ""); setCfg(w.config); setPre(w.prechat); setDomains(w.allowedDomains); };

  const liveProps = (() => {
    if (!embed.data) return null;
    const o = { widgetKey: embed.data.widgetKey, apiBase: embed.data.apiUrl ? `${embed.data.apiUrl.replace(/\/+$/, "")}`.replace(/\/api\/v1$/, "") + "/api/v1" : apiBase(), scriptUrl: embed.data.scriptUrl };
    return { doc: previewDoc(o), opts: o };
  })();

  const aside: ReactNode = (
    <div className="space-y-5 2xl:sticky 2xl:top-4">
      <FormSection title="Draft preview" description="Updates as you type. Not saved yet." className="max-2xl:hidden"><DraftCard cfg={cfg} prechatEnabled={pre.enabled} avatarSrc={avatarQ.data} /></FormSection>
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
              <TextField label="Launcher label" value={cfg.launcherLabel ?? ""} onChange={(e) => set("launcherLabel", e.target.value)} disabled={ro} maxLength={40} />
              <Select label="Theme" value={cfg.theme ?? "auto"} onChange={(e) => set("theme", e.target.value as WidgetConfig["theme"])} disabled={ro}><option value="auto">Match visitor</option><option value="light">Light</option><option value="dark">Dark</option></Select>
              <Select label="Position" value={cfg.position ?? "right"} onChange={(e) => set("position", e.target.value as WidgetConfig["position"])} disabled={ro}><option value="right">Bottom right</option><option value="left">Bottom left</option></Select>
              <TextField label="Input placeholder" value={cfg.inputPlaceholder ?? ""} onChange={(e) => set("inputPlaceholder", e.target.value)} disabled={ro} maxLength={80} />
            </div>
            <TextArea label="Welcome message" rows={2} value={cfg.welcomeMessage ?? ""} onChange={(e) => set("welcomeMessage", e.target.value)} disabled={ro} maxLength={500} />
          </FormSection>
          <FormSection title="Appearance" description="Pick your brand colours and a picture. The preview updates as you go.">
            <AppearanceFields cfg={cfg} setCfg={setCfg} ro={ro} avatarSrc={avatarQ.data} />
            <AvatarField w={w} ro={ro} onChanged={avatarCache} />
            <Advanced title="Advanced" summary="Use a picture from a web address instead">
              <TextField label="Picture web address" type="url" value={cfg.avatarUrl ?? ""} onChange={(e) => set("avatarUrl", e.target.value)} disabled={ro} placeholder="https://" hint="Only needed if your picture already lives online. An uploaded picture is used first." error={avatarBad ? "The address must start with https://" : undefined} />
            </Advanced>
          </FormSection>
          <FormSection title="Behaviour" description="Who answers, and whether the widget is on.">
            <Select label="Answering agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={ro} hint="Only a published agent answers. With no agent, visitors see an offline notice and a team member replies."><option value="">No agent (offline)</option>{(agents.data ?? []).filter((a) => a.status !== "archived").map((a) => <option key={a.id} value={a.id}>{a.name}{a.status === "published" ? "" : " (not published)"}</option>)}</Select>
            <ToggleRow id="w-enabled" title="Widget enabled" hint="Turn off to hide the chat on every site." checked={enabled} onChange={setEnabled} disabled={ro} />
          </FormSection>
          <FormSection title="Allowed domains" description="Only these sites can show the widget.">
            <ChipInput label="Add your website" hint="Type your site address, like example.com, and press Enter. Use *.example.com to include every subdomain. With no sites, the chat cannot show anywhere." values={domains} onChange={setDomains} disabled={ro} max={50} placeholder="example.com"
              normalize={(v) => (/^(https?:\/\/)?[^/?#]+/i.exec(v.trim())?.[0] ?? "").toLowerCase()}
              check={(v) => (allowedDomainSchema.safeParse(v).success ? null : `"${v}" does not look like a website address. Try example.com`)} addLabel="Add" />
            {badDomain && <p className="text-sm text-destructive">Invalid website: {badDomain}</p>}
          </FormSection>
          <FormSection title="Protection" description="Bots and spam are already blocked by default. Visitors who abuse the chat are blocked automatically (see the agent's Safety settings).">
            <Advanced title="Advanced protection" summary={ts?.enabled ? "Cloudflare check on" : "Honeypot on by default"} defaultOpen={!!ts?.enabled}>
            <ToggleRow id="w-hp" title="Honeypot field" hint="A hidden field that real visitors never see. Bots that fill it get a fake success and nothing is stored." checked={honeypot} onChange={(v) => setProt({ honeypot: v })} disabled={ro} />
            <ToggleRow id="w-ts" title="Cloudflare Turnstile" hint="Visitors pass a Cloudflare challenge before the chat starts. You use your own Cloudflare keys, so you control the challenge in your Cloudflare dashboard." checked={!!ts?.enabled} onChange={(v) => setTs({ enabled: v })} disabled={ro} />
            {ts?.enabled && <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
              <TextField label="Site key" value={ts.siteKey} onChange={(e) => setTs({ siteKey: e.target.value.trim() })} disabled={ro} maxLength={100} spellCheck={false} autoComplete="off"
                error={!ts.siteKey.trim() ? "Enter the site key from Cloudflare" : undefined} />
              <TextField label="Secret key" type="password" autoComplete="new-password" value={tsSecret} onChange={(e) => setTsSecret(e.target.value)} disabled={ro} maxLength={200}
                placeholder={hasSecret ? "A secret key is stored. Type to replace it." : "Paste the secret key"}
                hint={hasSecret ? "Stored encrypted. It is never shown again." : "Stored encrypted and never shown again."}
                error={!hasSecret && tsSecret.trim().length < 8 ? "Enter the secret key from Cloudflare" : undefined} />
              {w.hasTurnstileSecret && !clearSecret && !ro && <Button variant="outline" size="sm" type="button" onClick={() => { setClearSecret(true); setTsSecret(""); setTs({ enabled: false }); }}>Remove stored secret</Button>}
              <div className="grid gap-4 sm:grid-cols-3">
                <Select label="Theme" value={ts.theme} onChange={(e) => setTs({ theme: e.target.value as typeof ts.theme })} disabled={ro}><option value="auto">Match visitor</option><option value="light">Light</option><option value="dark">Dark</option></Select>
                <Select label="Size" value={ts.size} onChange={(e) => setTs({ size: e.target.value as typeof ts.size })} disabled={ro}><option value="normal">Normal</option><option value="compact">Compact</option><option value="flexible">Flexible</option></Select>
                <Select label="Appearance" value={ts.appearance} onChange={(e) => setTs({ appearance: e.target.value as typeof ts.appearance })} disabled={ro}><option value="always">Always visible</option><option value="interaction-only">Only when needed</option></Select>
              </div>
              <TextField label="Action (optional)" value={ts.action ?? ""} onChange={(e) => setTs({ action: e.target.value || undefined })} disabled={ro} maxLength={32} hint="Shown in your Cloudflare analytics. Letters, digits, - and _." />
              <p className="text-xs text-muted-foreground">To test locally, use Cloudflare's dummy keys: site key <code className="font-mono">1x00000000000000000000AA</code> with secret <code className="font-mono">1x0000000000000000000000000000000AA</code> always passes; <code className="font-mono">2x00000000000000000000AB</code> with <code className="font-mono">2x0000000000000000000000000000000AA</code> always fails.</p>
            </div>}
            </Advanced>
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
          <div className="overflow-y-auto px-4 pb-4"><DraftCard cfg={cfg} prechatEnabled={pre.enabled} avatarSrc={avatarQ.data} /></div>
        </SheetContent>
      </Sheet>
      {rot && <ConfirmModal danger title="Rotate the widget key?" body="The old key stops working immediately. Update the snippet on every site that embeds the widget." confirm="Rotate key" busy={rotate.isPending} onConfirm={() => rotate.mutate()} onClose={() => setRot(false)} />}
    </div>
  );
}
