import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { MessageSquareText, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errMsg } from "../common/api";
import { Empty, ErrorState, Loading, PageHeader, TextArea, TextField, useRole } from "../common/ui";
import { ops, type Canned } from "./opsApi";

export default function CannedPage() {
  const { atLeast, isAdmin } = useRole();
  const canWrite = atLeast("agent");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["canned"], queryFn: ops.canned });
  const [edit, setEdit] = useState<string | "new" | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const rm = useMutation({
    mutationFn: (c: Canned) => ops.deleteCanned(c.id),
    onSuccess: () => { setDel(null); toast.success("Response deleted"); void qc.invalidateQueries({ queryKey: ["canned"] }); },
    onError: (e) => toast.error("Could not delete response", { description: errMsg(e) }),
  });
  const newBtn = canWrite && <Button onClick={() => setEdit("new")}><Plus />New response</Button>;
  return (
    <div>
      <PageHeader title="Canned responses" subtitle="Type /shortcut in the inbox composer to insert a saved reply." actions={newBtn} />
      <AnimatePresence initial={false}>
        {edit === "new" && <motion.div key="new" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-3 overflow-hidden"><CannedForm c={null} onClose={() => setEdit(null)} /></motion.div>}
      </AnimatePresence>
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 && edit !== "new" ? <Empty icon={<MessageSquareText className="size-6" />} title="No canned responses" body="Save the answers you type most often." action={newBtn} /> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {q.data.map((c) => (
            <motion.li key={c.id} layout="position">
              {edit === c.id ? <CannedForm c={c} onClose={() => setEdit(null)} /> : (
                <Card className="h-full gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="font-medium">{c.title}</p><code className="rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-accent-foreground">/{c.shortcut}</code></div>
                    {canWrite && del !== c.id && <div className="flex shrink-0 gap-0.5">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEdit(c.id)}><Pencil /><span className="sr-only">Edit {c.title}</span></Button>
                      {isAdmin && <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setDel(c.id)}><Trash2 /><span className="sr-only">Delete {c.title}</span></Button>}
                    </div>}
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">{c.content}</p>
                  {del === c.id && (
                    <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 p-2.5 text-sm">
                      <span className="flex-1">Delete "{c.title}"?</span>
                      <Button size="sm" variant="outline" onClick={() => setDel(null)}>Keep</Button>
                      <Button size="sm" variant="destructive" disabled={rm.isPending} onClick={() => rm.mutate(c)}>Delete</Button>
                    </div>)}
                </Card>)}
            </motion.li>))}
        </ul>)}
    </div>
  );
}

function CannedForm({ c, onClose }: { c: Canned | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ shortcut: c?.shortcut ?? "", title: c?.title ?? "", content: c?.content ?? "" });
  const okShortcut = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(f.shortcut);
  const m = useMutation({
    mutationFn: () => (c ? ops.patchCanned(c.id, f) : ops.createCanned(f)),
    onSuccess: () => { toast.success(c ? "Response saved" : "Response created"); void qc.invalidateQueries({ queryKey: ["canned"] }); onClose(); },
    onError: (e) => toast.error("Could not save response", { description: errMsg(e) }),
  });
  return (
    <Card className="gap-3 border-primary/50 p-4">
      <form className="space-y-3" aria-label={c ? "Edit canned response" : "New canned response"} onSubmit={(e) => { e.preventDefault(); if (okShortcut && f.title.trim() && f.content.trim()) m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Shortcut" required maxLength={32} value={f.shortcut} error={f.shortcut && !okShortcut ? "Lowercase letters, numbers, - and _ only" : undefined} hint="Typed as /shortcut" onChange={(e) => setF({ ...f, shortcut: e.target.value.toLowerCase() })} />
          <TextField label="Title" required maxLength={100} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </div>
        <TextArea label="Content" required rows={4} maxLength={4000} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!okShortcut || !f.title.trim() || !f.content.trim() || m.isPending}>Save</Button></div>
      </form>
    </Card>
  );
}
