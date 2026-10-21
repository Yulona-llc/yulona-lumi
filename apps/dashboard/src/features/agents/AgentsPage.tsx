import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Sparkles } from "lucide-react";
import { ag, errMsg, type Agent } from "../common/api";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Stagger, StaggerItem } from "@/components/motion";
import { Badge, Empty, ErrorState, Loading, Modal, PageHeader, TextArea, TextField, useRole } from "../common/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const statusColor = { draft: "amber", published: "green", archived: "gray" } as const;

export default function AgentsPage() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agents"], queryFn: ag.agents });
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="h">
      <PageHeader title="Agents" subtitle="AI agents answer first from your knowledge and hand off to your team when unsure."
        actions={isAdmin && <div className="flex flex-col gap-2 sm:flex-row"><Button asChild variant="outline"><Link to="/agents/new-ai"><Sparkles />Create with AI</Link></Button><Button onClick={() => setOpen(true)}><Plus />New agent</Button></div>} />
      {q.isPending ? <div role="status" aria-live="polite" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><span className="sr-only">Loading agents…</span>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div>
        : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> :
        q.data.length === 0 ? <Empty icon={<Bot className="size-6" />} title="No agents yet" body="Create your first agent, add knowledge, then test it in the sandbox before publishing."
          action={isAdmin ? <div className="flex flex-wrap justify-center gap-2"><Button asChild><Link to="/agents/new-ai"><Sparkles />Create with AI</Link></Button><Button variant="outline" onClick={() => setOpen(true)}>Create agent</Button></div> : undefined} /> : (
          <Stagger className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {q.data.map((a: Agent) => (
              <StaggerItem key={a.id}>
                <Link to={`/agents/${a.id}`} className="group block h-full rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40">
                  <article className="flex h-full flex-col gap-3 rounded-2xl border bg-card p-4 transition-[border-color,box-shadow] group-hover:border-primary/50 group-hover:shadow-md sm:p-5">
                    <div className="flex items-start gap-3">
                      <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", a.status === "archived" ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground")}><Bot className="size-5" /></span>
                      <div className="min-w-0 flex-1"><h2 className="truncate font-display text-base font-semibold">{a.name}</h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">{a.publishedVersion ? `Live on version ${a.publishedVersion}` : "Never published"}</p></div>
                      <Badge color={statusColor[a.status]}>{a.status}</Badge>
                    </div>
                    <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">{a.description || "No description"}</p>
                  </article>
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        )}
      {open && <CreateAgent onClose={() => setOpen(false)} onDone={() => { setOpen(false); void qc.invalidateQueries({ queryKey: ["agents"] }); }} />}
    </section>
  );
}

function CreateAgent({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const m = useMutation({
    mutationFn: () => ag.createAgent({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
    onSuccess: () => { toast.success(`Created ${name.trim()}`); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Modal title="New agent" description="You can change everything later. It stays a draft until you publish." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoComplete="off" />
        <TextArea label="Description" hint="Optional. Only your team sees this." rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || !name.trim()}>{m.isPending && <Spinner />}Create</Button></div>
      </form>
    </Modal>
  );
}
