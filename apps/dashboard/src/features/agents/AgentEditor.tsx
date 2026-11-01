import { useEffect, useMemo, useState, useRef } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, FolderOpen, Rocket, RotateCcw, Save, Undo2 } from "lucide-react";
import { CONVERSION_STAGES, DEFAULT_ABUSE_CONFIG, STAGE_TRANSITIONS, type AgentConfig } from "@yulona/shared";
import { ag, errMsg, type Agent } from "../common/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Badge, ConfirmModal, ErrorState, fmtDate, Loading, RoleNotice, Select, TextArea, TextField, useRole } from "../common/ui";
import { DirtyDot, FormSection, StickyBar } from "../settings/parts";
import { ChipInput, WordSlider } from "../common/inputs";
import { SandboxConsole } from "./SandboxConsole";
import { CustomToolsPanel } from "../tools/ToolsPanel";
import { cn } from "@/lib/utils";

const BUILTIN = [
  ["qualify_lead", "Qualify lead", "Captures need, budget and timeline and moves the stage to qualified."],
  ["collect_contact", "Collect contact", "Asks for name, email and phone with a form."],
  ["escalate_to_human", "Escalate to human", "Hands the conversation to your team with a summary."],
  ["check_availability", "Check calendar availability", "Looks up open appointment times on the connected calendar (Google or Calendly)."],
  ["book_appointment", "Book appointments", "Books a time the customer confirmed. Needs a connected calendar (Settings > Calendar)."],
] as const;
const STAGE_ACTIONS: Record<string, string> = {
  visitor: "collect_contact, escalate_to_human", engaged: "+ qualify_lead", qualified: "+ qualify_lead", booking_offered: "collect_contact, escalate_to_human", booked: "escalate_to_human", handoff_requested: "none (AI paused)",
};
function PhrasesField({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  return <ChipInput label="Blocked phrases" hint="Type a word or phrase and press Enter. A message containing one counts as a strike (not case sensitive)." values={value} onChange={onChange} disabled={disabled} max={100} placeholder="Add a phrase" />;
}
const tempWord = (t: number) => (t <= 0.4 ? "Precise" : t <= 1.0 ? "Balanced" : t <= 1.5 ? "Creative" : "Very creative");

/** Model picker: the platform's enabled models in SaaS, a free-text field when the workspace runs its own provider. */
function ModelField({ value, onChange, disabled }: { value: string | undefined; onChange: (v: string | undefined) => void; disabled: boolean }) {
  const q = useQuery({ queryKey: ["models"], queryFn: () => ag.models(), staleTime: 5 * 60_000 });
  const list = q.data?.models ?? [];
  if (q.data?.mode === "saas" || (q.data && list.length)) {
    return (
      <Select label="Model" hint="Which AI model writes the replies. The default suits most teams." value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} disabled={disabled}>
        <option value="">Workspace default</option>
        {value && !list.includes(value) && <option value={value}>{value} (not currently offered)</option>}
        {list.map((m) => <option key={m} value={m}>{m}</option>)}
      </Select>
    );
  }
  return <TextField label="Model" hint="Leave empty to use your provider's default model. Otherwise type the model name exactly as your provider lists it." value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} disabled={disabled} maxLength={100} />;
}
const TABS = ["Persona", "Knowledge", "Escalation", "Tools", "Versions", "Sandbox"] as const;
type Tab = (typeof TABS)[number];
type Confirm = { kind: "publish" } | { kind: "rollback"; v: number } | null;

export default function AgentEditor() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["agent", id], queryFn: () => ag.agent(id) });
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t.toLowerCase() === new URLSearchParams(location.search).get("tab")?.toLowerCase()) ?? "Persona");
  if (q.isPending) return <Loading label="Loading agent" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  return <Editor agent={q.data} tab={tab} setTab={setTab} />;
}

function Editor({ agent, tab, setTab }: { agent: Agent; tab: Tab; setTab: (t: Tab) => void }) {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [cfg, setCfg] = useState<AgentConfig>(agent.config);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [note, setNote] = useState("");
  // Adopt server data (after save/publish/refetch) only for fields the user has not edited: a background refetch must not wipe unsaved edits.
  const base = useRef(agent);
  useEffect(() => {
    const old = base.current;
    base.current = agent;
    setName((v) => (v === old.name ? agent.name : v));
    setDescription((v) => (v === (old.description ?? "") ? (agent.description ?? "") : v));
    setCfg((v) => {
      if (JSON.stringify(v) !== JSON.stringify(old.config)) return v;
      return agent.config;
    });
  }, [agent]);
  const dirty = useMemo(() => name !== agent.name || description !== (agent.description ?? "") || JSON.stringify(cfg) !== JSON.stringify(agent.config), [name, description, cfg, agent]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["agent", agent.id] }); void qc.invalidateQueries({ queryKey: ["agents"] }); void qc.invalidateQueries({ queryKey: ["versions", agent.id] }); };
  const save = useMutation({
    mutationFn: () => ag.updateAgent(agent.id, { name: name.trim(), description: description.trim(), config: cfg }),
    onSuccess: (a) => { qc.setQueryData(["agent", agent.id], a); refresh(); toast.success("Draft saved"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const release = useMutation({
    mutationFn: () => (confirm?.kind === "rollback" ? ag.rollback(agent.id, confirm.v, note.trim() || undefined) : ag.publish(agent.id, note.trim() || undefined)),
    onSuccess: () => { toast.success(confirm?.kind === "rollback" ? `Rolled back to version ${confirm.v}` : "Published"); setConfirm(null); setNote(""); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const archived = agent.status === "archived";
  const ro = !isAdmin || archived;
  const canEdit = isAdmin && !archived;

  const toggleTool = (t: string, on: boolean) => set("enabledTools", on ? [...new Set([...cfg.enabledTools, t])] : cfg.enabledTools.filter((x) => x !== t));
  const discard = () => { setName(agent.name); setDescription(agent.description ?? ""); setCfg(agent.config); };

  return (
    <section aria-labelledby="h">
      <Link to="/agents" className="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" />All agents</Link>
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 id="h" className="font-display text-2xl font-semibold tracking-tight sm:text-[1.7rem]">{agent.name}</h1>
        <Badge color={archived ? "gray" : agent.publishedVersion ? "green" : "amber"}>{archived ? "archived" : agent.publishedVersion ? `Live · v${agent.publishedVersion}` : "Draft"}</Badge>
        <p className="w-full text-[0.9375rem] text-muted-foreground">{archived ? "Archived agent" : agent.publishedVersion ? `Live on version ${agent.publishedVersion}. Edits below are a draft until you publish.` : "Draft. Customers see nothing until you publish."}</p>
      </div>
      {!isAdmin && <RoleNotice what="editing agents" />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList aria-label="Agent sections" className="w-full sm:w-auto">
          {TABS.map((t) => <TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}
        </TabsList>

        <TabsContent value="Persona">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-5">
              <FormSection title="Identity" description="How your team recognises this agent.">
                <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={ro} maxLength={100} />
                <TextArea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={ro} maxLength={500} />
              </FormSection>
              <FormSection title="Voice and instructions" description="Role, tone, languages, goals and what to avoid.">
                <TextArea label="Persona and instructions (system prompt)" hint={`${cfg.systemPrompt.length}/8000`} rows={10} value={cfg.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} disabled={ro} maxLength={8000} className="min-h-48" />
                <TextArea label="Greeting" hint="Shown as the first message in the website widget when the widget has no Welcome message. Not sent on WhatsApp, Telegram or other channels." rows={2} value={cfg.greeting ?? ""} onChange={(e) => set("greeting", e.target.value || undefined)} disabled={ro} maxLength={1000} />
              </FormSection>
              <FormSection title="When it cannot answer" description="Two messages: first it asks to rephrase, then it hands off.">
                <TextArea label="Clarifying reply" hint="Sent when the agent cannot find an answer yet. It asks the customer to rephrase before handing off." rows={2} value={cfg.clarifyMessage} onChange={(e) => set("clarifyMessage", e.target.value)} disabled={ro} maxLength={1000} />
                <TextArea label="Handoff message" hint="Sent when the agent passes the conversation to a person. The way back to the AI is added after it automatically." rows={2} value={cfg.handoffMessage} onChange={(e) => set("handoffMessage", e.target.value)} disabled={ro} maxLength={1000} />
                <TextArea label="Fallback message" hint="Sent when the agent hands off after it still cannot answer from your knowledge." rows={2} value={cfg.fallbackMessage} onChange={(e) => set("fallbackMessage", e.target.value)} disabled={ro} maxLength={1000} />
              </FormSection>
            </div>
            <PromptHelper disabled={ro} onInsert={(t) => set("systemPrompt", (cfg.systemPrompt.trimEnd() + "\n\n" + t).slice(0, 8000))} />
          </div>
        </TabsContent>

        <TabsContent value="Knowledge">
          <div className="grid max-w-4xl gap-5 xl:grid-cols-2">
            <FormSection title="How it reads your knowledge" description="No embeddings and nothing to tune.">
              <p className="text-sm text-muted-foreground">Each source you add becomes a skill. The agent sees the list of skills, opens the sections it needs, and answers from them. Clear section titles and a good one-line description in <Link to="/knowledge" className="font-medium text-accent-foreground underline underline-offset-4">Knowledge</Link> help it most.</p>
              <ModelField value={cfg.model} onChange={(v) => set("model", v)} disabled={ro} />
              <WordSlider label="Reply style" hint="Precise sticks to your knowledge and gives steady answers. Creative sounds more varied." value={cfg.temperature} onChange={(v) => set("temperature", v)} left="Precise" right="Creative" describe={tempWord} disabled={ro} />
            </FormSection>
            <SkillsAvailable agentId={agent.id} />
          </div>
        </TabsContent>

        <TabsContent value="Escalation">
          <div className="grid gap-5 xl:grid-cols-2">
            <FormSection title="Hand off to a person" description="When the agent steps back and your team takes over.">
              <ChipInput label="Words that call a person" hint="Type a word or phrase and press Enter. When a visitor's message contains one, your team takes over." values={cfg.escalationRules.keywords} disabled={ro} max={50} placeholder="For example: refund, complaint"
                onChange={(keywords) => set("escalationRules", { ...cfg.escalationRules, keywords })} />
              <TextField label="Hand off after unanswered questions" hint="The agent asks the customer to rephrase first; it hands off after this many questions in a row it cannot answer. Customers who ask for a person are handed off at once." type="number" min={1} max={20} value={cfg.escalationRules.maxUnansweredTurns} disabled={ro}
                onChange={(e) => set("escalationRules", { ...cfg.escalationRules, maxUnansweredTurns: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} />
              <TextField label="Resume keyword" hint='While waiting for a person, customers can reply with this word to go back to the AI instead of waiting (for example "AI"). Leave empty to disable.' value={cfg.escalationRules.resumeKeyword} disabled={ro} maxLength={40}
                onChange={(e) => set("escalationRules", { ...cfg.escalationRules, resumeKeyword: e.target.value })} />
              <div className="flex items-start gap-3">
                <Switch id="handoff-qualified" checked={cfg.handoffAtQualified} onCheckedChange={(v) => set("handoffAtQualified", v)} disabled={ro} />
                <label htmlFor="handoff-qualified" className="text-sm"><span className="font-medium">Hand off qualified leads</span><span className="block text-muted-foreground">When a lead has shared what they need and a budget or timeline, pass the conversation to a person with a lead card.</span></label>
              </div>
            </FormSection>
            <FormSection title="Safety" description="Block visitors who keep sending abuse, spam or floods. On by default for every agent.">
              {(() => {
                const ab = cfg.abuse ?? DEFAULT_ABUSE_CONFIG;
                const setAb = (p: Partial<typeof ab>) => set("abuse", { ...ab, ...p });
                return <>
                  <div className="flex items-start gap-3">
                    <Switch id="abuse-enabled" checked={ab.enabled} onCheckedChange={(v) => setAb({ enabled: v })} disabled={ro} />
                    <label htmlFor="abuse-enabled" className="text-sm"><span className="font-medium">Block abusive visitors</span><span className="block text-muted-foreground">After the strike limit the agent says goodbye, the conversation is closed, the visitor is blocked and your owners and admins are notified. Only a person can unblock.</span></label>
                  </div>
                  {ab.enabled && <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <TextField label="Strikes before blocking" hint="Abusive, spam or flooding messages in one conversation." type="number" min={1} max={10} value={ab.maxStrikes} disabled={ro}
                        onChange={(e) => setAb({ maxStrikes: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} />
                      <TextField label="Messages per minute" hint="More than this in a minute counts as a strike." type="number" min={2} max={60} value={ab.maxMessagesPerMinute} disabled={ro}
                        onChange={(e) => setAb({ maxMessagesPerMinute: Math.min(60, Math.max(2, Number(e.target.value) || 2)) })} />
                    </div>
                    <PhrasesField value={ab.blockedPhrases} onChange={(v) => setAb({ blockedPhrases: v })} disabled={ro} />
                    <TextArea label="Farewell message" hint="The last message the visitor sees." rows={2} value={ab.farewellMessage} onChange={(e) => setAb({ farewellMessage: e.target.value })} disabled={ro} maxLength={500} />
                  </>}
                </>;
              })()}
            </FormSection>
            <FormSection title="Stage rules" description="The funnel is fixed. The agent can only use these actions at each stage.">
              <ul className="-my-1 divide-y">
                {CONVERSION_STAGES.map((s) => (
                  <li key={s} className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr]">
                    <p className="text-sm font-semibold capitalize">{s.replace("_", " ")}</p>
                    <div className="space-y-1 text-sm">
                      <p><span className="text-muted-foreground">Actions: </span>{STAGE_ACTIONS[s]}</p>
                      <p><span className="text-muted-foreground">Can move to: </span>{STAGE_TRANSITIONS[s].join(", ").replaceAll("_", " ") || "nothing"}</p>
                    </div>
                  </li>))}
              </ul>
            </FormSection>
          </div>
        </TabsContent>

        <TabsContent value="Tools">
          <div className="grid gap-5 xl:grid-cols-2">
            <FormSection title="Built-in tools" description="Switch off what this agent should not do.">
              <ul className="-my-2 divide-y">{BUILTIN.map(([k, l, d]) => (
                <li key={k} className="flex items-start justify-between gap-4 py-3">
                  <label htmlFor={`tool-${k}`} className="min-w-0 cursor-pointer"><span className="block font-medium">{l}</span><span className="block text-sm text-muted-foreground">{d}</span></label>
                  <Switch id={`tool-${k}`} checked={cfg.enabledTools.includes(k)} onCheckedChange={(v) => toggleTool(k, v)} disabled={ro} />
                </li>))}</ul>
            </FormSection>
            <CustomToolsPanel agentId={agent.id} cfg={cfg} update={(patch) => setCfg((c) => ({ ...c, ...patch }))} ro={ro} />
          </div>
        </TabsContent>

        <TabsContent value="Versions">
          <Versions agent={agent} canEdit={canEdit} onRollback={(v) => setConfirm({ kind: "rollback", v })} />
        </TabsContent>

        <TabsContent value="Sandbox">
          {dirty ? <Alert variant="warning"><AlertDescription>Save your draft first. The sandbox runs the last saved draft.</AlertDescription></Alert> : <SandboxConsole agentId={agent.id} />}
        </TabsContent>
      </Tabs>

      {isAdmin && <ArchiveBar agent={agent} onDone={refresh} />}

      {canEdit && (
        <StickyBar>
          {dirty ? <DirtyDot /> : <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{agent.publishedVersion ? `All changes saved. Live: v${agent.publishedVersion}` : "All changes saved"}</p>}
          {dirty && <Button variant="ghost" size="icon" onClick={discard} aria-label="Discard changes" className="max-sm:hidden"><Undo2 /></Button>}
          <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Save />}Save draft</Button>
          <Button disabled={dirty || release.isPending} onClick={() => setConfirm({ kind: "publish" })} title={dirty ? "Save your draft before publishing" : undefined}><Rocket />Publish</Button>
        </StickyBar>
      )}

      {confirm && (
        <ConfirmModal title={confirm.kind === "publish" ? "Publish this draft?" : `Roll back to version ${confirm.v}?`} confirm={confirm.kind === "publish" ? "Publish" : "Roll back"} busy={release.isPending} onConfirm={() => release.mutate()} onClose={() => setConfirm(null)}
          body={<div className="space-y-3"><p>{confirm.kind === "publish" ? "Publishing snapshots the saved draft as a new version. Customers will talk to it immediately." : "This republishes that configuration as a new version."}</p>
            <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></div>} />
      )}
    </section>
  );
}

/** The skills this agent can read, tying the agent to the Knowledge area. */
function SkillsAvailable({ agentId }: { agentId: string }) {
  const q = useQuery({ queryKey: ["sources"], queryFn: () => ag.sources() });
  const mine = (q.data ?? []).filter((s) => s.agentId === null || s.agentId === agentId);
  return (
    <FormSection title="Skills it can read" description="Shared skills plus any added for this agent only.">
      {q.isPending ? <Loading rows={2} /> : q.isError ? <p className="text-sm text-muted-foreground">Could not load skills. Manage them in Knowledge.</p> : mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills yet. Without knowledge the agent hands every question to your team. <Link to="/knowledge" className="font-medium text-accent-foreground underline underline-offset-4">Add one</Link>.</p>
      ) : (
        <ul className="-my-1 divide-y">{mine.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2.5">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1"><p className="truncate font-mono text-sm">{s.skill ?? s.name}</p><p className="truncate text-xs text-muted-foreground">{s.description ?? s.name}</p></div>
            <span className="text-xs tabular-nums text-muted-foreground">{s.chunkCount} sections</span>
          </li>))}</ul>
      )}
    </FormSection>
  );
}

function PromptHelper({ onInsert, disabled }: { onInsert: (t: string) => void; disabled: boolean }) {
  const [tone, setTone] = useState("friendly and concise");
  const [langs, setLangs] = useState("English");
  const [goals, setGoals] = useState("Answer questions, qualify the lead, and offer a booking.");
  return (
    <FormSection title="Prompt helper" description="Appends a structured block to the prompt." className="h-fit xl:sticky xl:top-4">
      <TextField label="Tone" value={tone} onChange={(e) => setTone(e.target.value)} />
      <TextField label="Languages" value={langs} onChange={(e) => setLangs(e.target.value)} />
      <TextArea label="Goals" rows={3} value={goals} onChange={(e) => setGoals(e.target.value)} />
      <Button variant="outline" className="w-full" disabled={disabled} onClick={() => { onInsert(`Tone: ${tone}.\nReply in: ${langs}.\nGoals: ${goals}`); toast.success("Added to the prompt"); }}>Append to prompt</Button>
    </FormSection>
  );
}

function Versions({ agent, canEdit, onRollback }: { agent: Agent; canEdit: boolean; onRollback: (v: number) => void }) {
  const q = useQuery({ queryKey: ["versions", agent.id], queryFn: () => ag.versions(agent.id) });
  return (
    <FormSection title="Version history" description="Every publish is an immutable snapshot you can roll back to." className="max-w-2xl">
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No versions yet. Publish the draft to make this agent live.</p>
      ) : (
        <ol className="relative ml-2 space-y-5 border-l pl-6">
          {q.data.map((v) => {
            const live = v.version === agent.publishedVersion;
            return (
              <li key={v.version} className="relative">
                <span aria-hidden className={cn("absolute -left-[1.9rem] top-1 size-3 rounded-full border-2 border-card", live ? "bg-primary ring-4 ring-primary/20" : "bg-border")} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">Version {v.version}{live && <Badge color="green">live</Badge>}</p>
                    <p className="text-sm text-muted-foreground">{v.note || "No note"}</p>
                    <p className="text-xs text-muted-foreground">{fmtDate(v.createdAt)}</p>
                  </div>
                  {canEdit && !live && <Button variant="outline" size="sm" onClick={() => onRollback(v.version)}><RotateCcw />Roll back<span className="sr-only"> to version {v.version}</span></Button>}
                </div>
              </li>);
          })}
        </ol>
      )}
    </FormSection>
  );
}

function ArchiveBar({ agent, onDone }: { agent: Agent; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const archived = agent.status === "archived";
  const m = useMutation({
    mutationFn: () => (archived ? ag.unarchive(agent.id) : ag.archive(agent.id)),
    onSuccess: (r) => {
      setOpen(false); onDone(); toast.success(archived ? "Unarchived" : "Archived");
      const w = (r as { warning?: { widgets: { name: string }[]; channels: { name: string }[] } } | undefined)?.warning;
      if (w) {
        const names = [...w.widgets.map((x) => `widget "${x.name}"`), ...w.channels.map((x) => `channel "${x.name}"`)].join(", ");
        toast.warning(`Still attached to ${names}. Visitors there get a "not available" reply until you attach another agent.`);
      }
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t pt-5">
      <p className="text-sm text-muted-foreground">{archived ? "This agent is archived and does not answer visitors." : "Archiving stops this agent answering visitors. You can undo it."}</p>
      <Button variant="outline" onClick={() => (archived ? m.mutate() : setOpen(true))}>{archived ? "Unarchive agent" : "Archive agent"}</Button>
      {open && <ConfirmModal danger title="Archive this agent?" body="It stops answering visitors. You can unarchive it later." confirm="Archive" busy={m.isPending} onConfirm={() => m.mutate()} onClose={() => setOpen(false)} />}
    </div>
  );
}
