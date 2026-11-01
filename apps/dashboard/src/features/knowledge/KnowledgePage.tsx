import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, ChevronDown, FileText, Minus, Plus, FileUp, FolderOpen, Globe, ListTree, MoreHorizontal, Pencil, RefreshCw, Trash2, Type, UploadCloud } from "lucide-react";
import { ag, errMsg, uploadFile, type KnowledgeSource } from "../common/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Badge, ConfirmModal, Empty, ErrorState, fmtBytes, fmtDate, Loading, Modal, PageHeader, Select, TextArea, TextField, useRole } from "../common/ui";
import { useMediaQuery } from "../settings/parts";
import { cn } from "@/lib/utils";

const color = { pending: "gray", processing: "blue", ready: "green", failed: "red" } as const;
const ACCEPT = ".pdf,.docx,.txt,.md,.html,.htm";
const MAX = 10 * 1024 * 1024;
const DEFAULT_DEPTH = 3, MAX_DEPTH = 5, DEFAULT_PAGES = 25, MAX_PAGES = 50;
const TYPE_ICON = { file: FileText, url: Globe, text: Type } as const;
type Kind = "file" | "url" | "text";

export default function KnowledgePage() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["sources"], queryFn: () => ag.sources(),
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "pending" || s.status === "processing") ? 3000 : false),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: ag.agents });
  const [add, setAdd] = useState<null | { kind: Kind; file?: File }>(null);
  const [del, setDel] = useState<KnowledgeSource | null>(null);
  const [view, setView] = useState<KnowledgeSource | null>(null);
  const [over, setOver] = useState(false);
  const inv = () => void qc.invalidateQueries({ queryKey: ["sources"] });
  const re = useMutation({ mutationFn: (s: KnowledgeSource) => ag.reingest(s.id), onSuccess: (_d, s) => { toast.success(`Reingesting ${s.name}`); inv(); }, onError: (e) => toast.error(errMsg(e)) });
  const rm = useMutation({ mutationFn: (s: KnowledgeSource) => ag.deleteSource(s.id), onSuccess: (_d, s) => { setDel(null); toast.success(`Deleted ${s.name}`); inv(); }, onError: (e) => toast.error(errMsg(e)) });
  const agentName = (id: string | null) => (id ? agents.data?.find((a) => a.id === id)?.name ?? "One agent" : "All agents");

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && isAdmin) setAdd({ kind: "file", file: f });
  };

  return (
    <section aria-labelledby="h">
      <PageHeader title="Knowledge" subtitle="Each file, web page or text becomes a skill. The agent sees the list of skills, then opens only the sections it needs to answer." />
      {isAdmin && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className={cn("mb-6 flex flex-col items-stretch gap-3 rounded-2xl border border-dashed bg-card/60 p-3 transition-colors lg:flex-row lg:items-center lg:p-4", over && "border-primary bg-accent")}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"><UploadCloud className="size-5" /></span>
            <p className="text-sm text-muted-foreground"><span className="hidden lg:inline">Drop a file anywhere here, or add a skill from a page or text.</span><span className="lg:hidden">Add a skill from a file, a web page or text.</span></p>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:flex">
            <Button className="max-sm:px-2" onClick={() => setAdd({ kind: "file" })}><FileUp />Upload file</Button>
            <Button variant="outline" className="max-sm:px-2" onClick={() => setAdd({ kind: "url" })}><Globe />Add URL</Button>
            <Button variant="outline" className="max-sm:px-2" onClick={() => setAdd({ kind: "text" })}><Type />Add text</Button>
          </div>
        </div>
      )}
      {q.isPending ? <div role="status" aria-live="polite" className="space-y-3"><span className="sr-only">Loading sources…</span>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> :
        q.data.length === 0 ? <Empty icon={<FolderOpen className="size-6" />} title="No knowledge yet" body="Without knowledge, the agent cannot answer and will hand every question to your team. Add a help page or upload a PDF." /> : (
          <ul className="space-y-3">
            <AnimatePresence initial={false}>
              {q.data.map((s) => (
                <motion.li key={s.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.22 }}>
                  <SkillRow s={s} isAdmin={isAdmin} agent={agentName(s.agentId)} onSections={() => setView(s)} onReingest={() => re.mutate(s)} onDelete={() => setDel(s)} busy={re.isPending} />
                </motion.li>))}
            </AnimatePresence>
          </ul>)}
      {add && <AddSource kind={add.kind} file={add.file} agents={agents.data ?? []} onClose={() => setAdd(null)} onDone={() => { setAdd(null); inv(); }} />}
      {view && <Sections source={view} onClose={() => setView(null)} />}
      {del && <ConfirmModal danger title="Delete this skill?" body={<>"{del.name}" and its {del.chunkCount} sections will be removed. Agents stop using it immediately.</>} confirm="Delete" busy={rm.isPending} onConfirm={() => rm.mutate(del)} onClose={() => setDel(null)} />}
    </section>
  );
}

/** "Read 4 of 12 pages found" while crawling, "Read 12 pages" afterwards. */
function crawlText(s: KnowledgeSource): string | null {
  const p = s.crawlProgress;
  if (s.type !== "url" || !p) return null;
  const noun = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
  if (!p.done) return `Reading pages: ${p.pagesCrawled} read, ${p.pagesFound} found so far (up to ${s.maxPages ?? p.pagesFound}).`;
  return `Read ${noun(p.pagesCrawled)}${p.pagesSkipped ? `, skipped ${p.pagesSkipped}` : ""}${p.truncated ? " (stopped early to stay on time)" : ""}.`;
}

function SkillRow({ s, isAdmin, agent, onSections, onReingest, onDelete, busy }: { s: KnowledgeSource; isAdmin: boolean; agent: string; onSections: () => void; onReingest: () => void; onDelete: () => void; busy: boolean }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(s.name);
  const [desc, setDesc] = useState(s.description ?? "");
  const working = s.status === "pending" || s.status === "processing";
  const Icon = TYPE_ICON[s.type];
  const patch = useMutation({
    mutationFn: (b: { name?: string; description?: string | null }) => ag.updateSource(s.id, b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: ["sources"] });
      const prev = qc.getQueryData<KnowledgeSource[]>(["sources"]);
      qc.setQueryData<KnowledgeSource[]>(["sources"], (old) => old?.map((x) => (x.id === s.id ? { ...x, ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}) } : x)));
      return { prev };
    },
    onError: (e, _b, ctx) => { if (ctx?.prev) qc.setQueryData(["sources"], ctx.prev); toast.error(errMsg(e)); },
    onSuccess: (_r, b) => toast.success(b.description === null ? "Using the automatic description" : "Skill saved"),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["sources"] }),
  });
  const startEdit = () => { setName(s.name); setDesc(s.description ?? ""); setEdit(true); };
  const commit = () => {
    const body: { name?: string; description?: string } = {};
    if (name.trim() && name.trim() !== s.name) body.name = name.trim();
    if (desc.trim() && desc.trim() !== (s.description ?? "")) body.description = desc.trim();
    setEdit(false);
    if (Object.keys(body).length) patch.mutate(body);
  };
  const key = (e: React.KeyboardEvent) => { if (e.key === "Escape") setEdit(false); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(); };

  return (
    <article className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl", s.status === "failed" ? "bg-destructive/12 text-destructive" : "bg-accent text-accent-foreground")}>
          {working ? <Spinner /> : s.status === "failed" ? <AlertCircle className="size-5" /> : <FolderOpen className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {edit ? null : <h2 className="font-display text-base font-semibold">{s.name}</h2>}
            <Badge color={color[s.status]}>{s.status === "processing" ? "processing…" : s.status}</Badge>
          </div>
          {s.skill && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={s.skill}>skills/{s.skill}/</p>}

          {edit ? (
            <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); commit(); }} onKeyDown={key}>
              <div className="grid gap-1.5"><Label htmlFor={`n-${s.id}`}>Name</Label><Input id={`n-${s.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></div>
              <div className="grid gap-1.5"><Label htmlFor={`d-${s.id}`}>Description</Label><Textarea id={`d-${s.id}`} autoFocus rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} />
                <p className="text-xs text-muted-foreground">One line telling the agent when to open this skill.</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm">Save skill</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEdit(false)}>Cancel</Button>
                <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => { setEdit(false); patch.mutate({ description: null }); }}>Use automatic description</Button>
              </div>
            </form>
          ) : (
            <div className="mt-1.5 flex items-start gap-1">
              <p className="min-w-0 max-w-prose text-sm text-muted-foreground">{s.description || (working ? "Writing a description…" : "No description yet")}</p>
              {isAdmin && !working && <Button variant="ghost" size="icon-sm" onClick={startEdit} aria-label={`Edit ${s.name}`}><Pencil /></Button>}
            </div>
          )}

          {working && (
            <div className="mt-3" role="status" aria-live="polite">
              {s.status === "pending" ? <Progress value={8} aria-label="Queued" /> : (
                <div className="relative h-2 overflow-hidden rounded-full bg-muted"><motion.div className="absolute inset-y-0 w-1/3 rounded-full bg-primary" animate={{ left: ["-35%", "105%"] }} transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }} /></div>)}
              <p className="mt-1.5 text-xs text-muted-foreground">{s.status === "pending" ? "Queued. Reading starts shortly." : crawlText(s) ?? "Reading and splitting into sections…"}</p>
            </div>
          )}
          {s.status === "failed" && s.error && <p className="mt-2 text-sm text-destructive">{s.error}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Icon className="size-3.5" />{s.type}</span>
            <span className="inline-flex items-center gap-1 tabular-nums"><ListTree className="size-3.5" />{s.chunkCount} sections</span>
            <span className="min-w-0 max-w-full truncate font-mono">{s.sourceUrl ?? s.fileName ?? "Pasted text"}</span>
            {s.type === "url" && s.status === "ready" && s.crawlProgress && <span className="tabular-nums">{crawlText(s)}</span>}
            <span className="tabular-nums">{fmtBytes(s.sizeBytes)}</span>
            <span>{fmtDate(s.lastIngestedAt)}</span>
            <span>{agent}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" className="max-sm:hidden" disabled={s.chunkCount === 0} onClick={onSections}>Sections<span className="sr-only"> of {s.name}</span></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${s.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={s.chunkCount === 0} onSelect={onSections}><ListTree />Sections</DropdownMenuItem>
              {isAdmin && <>
                <DropdownMenuItem disabled={busy || working} onSelect={onReingest}><RefreshCw />Reingest</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}><Trash2 />Delete</DropdownMenuItem></>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}

function AddSource({ kind, file: initial, agents, onClose, onDone }: { kind: Kind; file?: File; agents: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }) {
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [follow, setFollow] = useState(true);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [pages, setPages] = useState(DEFAULT_PAGES);
  const [subdomains, setSubdomains] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState<string>();
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: async () => {
      const base = { ...(agentId ? { agentId } : {}) };
      if (kind === "file") return uploadFile(file!, { ...base, name: name.trim() || undefined }, setPct);
      if (kind === "url") return ag.addUrl({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...base, ...(follow ? { followLinks: true, maxDepth: depth, maxPages: pages, includeSubdomains: subdomains } : { followLinks: false, maxPages: 1 }) });
      return ag.addText({ name: name.trim(), text, ...base });
    },
    onSuccess: () => { toast.success(kind === "file" ? "Uploaded. Reading it now." : "Added. Reading it now."); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const pick = (f: File | null) => {
    setErr(undefined);
    if (f && f.size > MAX) { setErr("File is larger than 10 MB."); setFile(null); return; }
    if (f && !new RegExp(`(${ACCEPT.replaceAll(".", "\\.").replaceAll(",", "|")})$`, "i").test(f.name)) { setErr("Unsupported type. Use PDF, DOCX, TXT, MD or HTML."); setFile(null); return; }
    setFile(f);
  };
  const [seeded, setSeeded] = useState(false);
  if (!seeded) { setSeeded(true); if (initial) pick(initial); }
  const valid = kind === "file" ? !!file : kind === "url" ? /^https?:\/\//i.test(url.trim()) : !!(name.trim() && text.trim());
  const title = kind === "file" ? "Upload a file" : kind === "url" ? "Add a web page" : "Add text";
  return (
    <Modal title={title} description="It becomes a skill with a description and titled sections the agent can read." onClose={m.isPending ? () => undefined : onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }}>
        {err && <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/35 bg-destructive/8 px-3 py-2.5 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />{err}</div>}
        {kind === "file" && (
          <div>
            <label
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0] ?? null); }}
              className={cn("flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center transition-colors focus-within:ring-[3px] focus-within:ring-ring/40 hover:bg-muted/50", over && "border-primary bg-accent")}
            >
              <input ref={fileRef} type="file" accept={ACCEPT} aria-label="File (PDF, DOCX, TXT, MD or HTML, max 10 MB)" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
              <UploadCloud className="size-7 text-muted-foreground" />
              <span className="text-sm font-medium">{file ? file.name : "Drop a file here, or tap to browse"}</span>
              <span className="text-xs text-muted-foreground">{file ? fmtBytes(file.size) : "PDF, DOCX, TXT, MD or HTML, up to 10 MB"}</span>
            </label>
            {m.isPending && <div className="mt-3"><Progress value={pct} aria-label="Upload progress" /><p className="mt-1 text-sm tabular-nums text-muted-foreground" aria-live="polite">{pct}% uploaded</p></div>}
          </div>)}
        {kind === "url" && <>
          <TextField label="URL" type="url" placeholder="https://example.com/help" value={url} onChange={(e) => setUrl(e.target.value)} required />
          <div className="rounded-2xl border p-3.5">
            <div className="flex items-start gap-3">
              <Switch id="follow-links" checked={follow} onCheckedChange={setFollow} className="mt-0.5" />
              <div className="min-w-0 flex-1"><Label htmlFor="follow-links" className="cursor-pointer">Follow links on this site</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">{follow ? "Lumi reads this page, then the pages it links to on the same site." : "Lumi reads only this one page."} Private network addresses are blocked, and the site&apos;s robots.txt is respected.</p></div>
            </div>
            {follow && (
              <div className="mt-4 space-y-4 border-t pt-4">
                <div className="grid gap-1.5">
                  <Label id="depth-l">How deep</Label>
                  <div className="flex items-center gap-2" role="group" aria-labelledby="depth-l">
                    <Button type="button" variant="outline" size="icon" aria-label="Go less deep" disabled={depth <= 1} onClick={() => setDepth((d) => Math.max(1, d - 1))}><Minus /></Button>
                    <output aria-live="polite" aria-label="Depth" className="min-w-10 text-center text-lg font-semibold tabular-nums">{depth}</output>
                    <Button type="button" variant="outline" size="icon" aria-label="Go deeper" disabled={depth >= MAX_DEPTH} onClick={() => setDepth((d) => Math.min(MAX_DEPTH, d + 1))}><Plus /></Button>
                  </div>
                  <p className="text-xs text-muted-foreground">How many clicks away from this page Lumi will go. 1 is only the pages linked from here; {DEFAULT_DEPTH} suits most websites; 5 reaches deep into big sites.</p>
                </div>
                <TextField label="Max pages" type="number" min={1} max={MAX_PAGES} value={pages} onChange={(e) => setPages(Math.min(MAX_PAGES, Math.max(1, Number(e.target.value) || 1)))} hint={`Lumi stops after this many pages (up to ${MAX_PAGES}), even if it could go further.`} />
                <div className="flex items-start gap-3">
                  <Switch id="subdomains" checked={subdomains} onCheckedChange={setSubdomains} className="mt-0.5" />
                  <div className="min-w-0 flex-1"><Label htmlFor="subdomains" className="cursor-pointer">Include subdomains</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">Also read pages such as blog.example.com when you start from example.com.</p></div>
                </div>
              </div>)}
          </div></>}
        {kind === "text" && <TextArea label="Text" rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={900000} required />}
        <TextField label={kind === "text" ? "Name" : "Name (optional)"} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required={kind === "text"} />
        <Select label="Available to" value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose} disabled={m.isPending}>Cancel</Button><Button disabled={!valid || m.isPending}>{m.isPending && <Spinner />}{kind === "file" ? "Upload" : "Add"}</Button></div>
      </form>
    </Modal>
  );
}

/** Drawer listing a skill's numbered, titled sections with expandable text. */
function Sections({ source, onClose }: { source: KnowledgeSource; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const desktop = useMediaQuery("(min-width: 768px)");
  const q = useQuery({ queryKey: ["chunks", source.id, page], queryFn: () => ag.chunks(source.id, page * 20) });
  const isUrl = source.type === "url";
  const all = useQuery({ queryKey: ["chunks-all", source.id], queryFn: () => ag.chunks(source.id, 0, 100), enabled: isUrl });
  const pageList = [...(all.data ?? []).reduce((m, c) => (c.url ? m.set(c.url, (m.get(c.url) ?? 0) + 1) : m), new Map<string, number>())];
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side={desktop ? "right" : "bottom"} className={cn("gap-0 p-0", desktop ? "sm:max-w-xl" : "h-[88dvh]")}>
        <SheetHeader className="border-b">
          <SheetTitle>Sections: {source.name}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{source.skill ? `skills/${source.skill}/` : `${source.chunkCount} sections`}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isUrl && pageList.length > 0 && (
            <details className="mb-3 rounded-xl border bg-background" open={pageList.length <= 6}>
              <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-medium">Pages read ({pageList.length})</summary>
              <ul className="space-y-1 border-t px-3 py-2.5">{pageList.map(([u, n]) => (
                <li key={u} className="flex items-baseline justify-between gap-3 text-xs"><span className="min-w-0 truncate font-mono text-muted-foreground" title={u}>{u}</span><span className="shrink-0 tabular-nums text-muted-foreground">{n} {n === 1 ? "section" : "sections"}</span></li>))}</ul>
            </details>)}
          {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 ? <p className="text-sm text-muted-foreground">No sections on this page.</p> : (
            <ol className="space-y-2.5">{q.data.map((c) => {
              const isOpen = open.has(c.id);
              return (
                <li key={c.id} className="rounded-xl border bg-background">
                  <button type="button" onClick={() => toggle(c.id)} aria-expanded={isOpen} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold tabular-nums">{c.chunkIndex + 1}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{c.title || "Untitled section"}</span><span className="block truncate text-xs tabular-nums text-muted-foreground">{c.url ? <span className="font-mono">{c.url}</span> : null}{c.url ? " · " : ""}{c.tokenCount} tokens</span></span>
                    <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                      <p className="whitespace-pre-wrap border-t px-3 py-3 text-sm text-muted-foreground">{c.content}</p></motion.div>}
                  </AnimatePresence>
                </li>);
            })}</ol>)}
        </div>
        <div className="flex justify-between border-t p-3">
          <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button variant="outline" disabled={(q.data?.length ?? 0) < 20} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
