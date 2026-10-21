import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Check, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { Empty, ErrorState, Loading, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";
import { ops, type Tag } from "./opsApi";

const SWATCHES = ["#f97316", "#dc2626", "#d97706", "#15803d", "#0d9488", "#1d4ed8", "#7c3aed", "#db2777", "#64748b", "#0f1a2f"];

export default function TagsPage() {
  const { atLeast, isAdmin } = useRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tags"], queryFn: ops.tags });
  const [edit, setEdit] = useState<string | "new" | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const rm = useMutation({
    mutationFn: (t: Tag) => ops.deleteTag(t.id),
    onSuccess: () => { setDel(null); toast.success("Tag deleted"); void qc.invalidateQueries({ queryKey: ["tags"] }); },
    onError: (e) => toast.error("Could not delete tag", { description: errMsg(e) }),
  });
  const newBtn = atLeast("agent") && <Button onClick={() => setEdit("new")}><Plus />New tag</Button>;
  return (
    <div>
      <PageHeader title="Tags" subtitle="Label conversations, contacts and tickets." actions={newBtn} />
      {!isAdmin && <RoleNotice what="renaming or deleting tags" />}
      <AnimatePresence initial={false}>
        {edit === "new" && <motion.div key="new" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-3 overflow-hidden"><TagForm t={null} onClose={() => setEdit(null)} /></motion.div>}
      </AnimatePresence>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 && edit !== "new" ? <Empty icon={<TagIcon className="size-6" />} title="No tags yet" body="Create tags to organise your work." action={newBtn} /> : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.map((t) => (
            <motion.li key={t.id} layout="position">
              {edit === t.id ? <TagForm t={t} onClose={() => setEdit(null)} /> : (
                <Card className="gap-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2.5"><span className="size-4 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: t.color }} aria-hidden="true" /><span className="truncate font-medium">{t.name}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t.count ?? 0} used</span></span>
                    {isAdmin && del !== t.id && <span className="flex shrink-0 gap-0.5"><Button variant="ghost" size="icon-sm" onClick={() => setEdit(t.id)}><Pencil /><span className="sr-only">Edit {t.name}</span></Button><Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setDel(t.id)}><Trash2 /><span className="sr-only">Delete {t.name}</span></Button></span>}
                  </div>
                  {del === t.id && (
                    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 p-2.5 text-sm">
                      <span className="flex-1">Remove "{t.name}" from everything?</span>
                      <Button size="sm" variant="outline" onClick={() => setDel(null)}>Keep</Button>
                      <Button size="sm" variant="destructive" disabled={rm.isPending} onClick={() => rm.mutate(t)}>Delete</Button>
                    </div>)}
                </Card>)}
            </motion.li>))}
        </ul>)}
    </div>
  );
}

function TagForm({ t, onClose }: { t: Tag | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(t?.name ?? "");
  const [color, setColor] = useState(t?.color ?? SWATCHES[0]!);
  const swatches = SWATCHES.includes(color) ? SWATCHES : [color, ...SWATCHES];
  const m = useMutation({
    mutationFn: () => (t ? ops.patchTag(t.id, { name: name.trim(), color }) : ops.createTag({ name: name.trim(), color })),
    onSuccess: () => { toast.success(t ? "Tag saved" : "Tag created"); void qc.invalidateQueries({ queryKey: ["tags"] }); onClose(); },
    onError: (e) => toast.error("Could not save tag", { description: errMsg(e) }),
  });
  return (
    <Card className="gap-3 border-primary/50 p-4">
      <form className="space-y-3" aria-label={t ? "Edit tag" : "New tag"} onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }}>
        <TextField label="Name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
          {swatches.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={`Color ${c}`} onClick={() => setColor(c)}
              className={cn("grid size-9 place-items-center rounded-full outline-none ring-offset-2 ring-offset-card transition-transform focus-visible:ring-2 focus-visible:ring-ring", c === color && "ring-2 ring-foreground")} style={{ background: c }}>
              {c === color && <Check className="size-4 text-white" strokeWidth={3} />}
            </button>))}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || m.isPending}>Save</Button></div>
      </form>
    </Card>
  );
}
