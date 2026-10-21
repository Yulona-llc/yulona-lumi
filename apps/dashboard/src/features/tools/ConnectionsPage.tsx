import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, KeyRound, Pencil, Plug, Plus, ShieldCheck, Trash2, TriangleAlert, Zap } from "lucide-react";
import { ApiError } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { ConfirmModal, Empty, ErrorState, Modal, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";
import { rememberConnectionTest, tl, toolKeys, useConnectionTests, type Connection } from "./api";
import { ConnectionForm, ConnectionTestResult } from "./ConnectionForm";
import { AUTH_LABEL } from "./model";

/** "Still used by agent X": the 409 from DELETE /tool-connections/:id, turned into a sentence a person can act on. */
export function inUseMessage(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const agents = (e.details as { agents?: string[] } | undefined)?.agents;
  const names = agents?.length ? agents.join(", ") : e.message.replace(/^.*tools of:\s*/i, "");
  return `Still used by ${names}. Open that agent's Tools tab, switch the tool to another connection or delete the tool, save the agent, then delete this connection.`;
}

function RotateSecret({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const basic = conn.authType === "basic";
  const value = basic ? `${user}:${pass}` : secret;
  const m = useMutation({
    mutationFn: () => tl.updateConnection(conn.id, { secret: value }),
    onSuccess: () => { toast.success("Secret rotated", { description: "Test the connection to check the new secret works." }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const ok = basic ? !!user && !!pass : !!secret.trim();
  return (
    <Modal title="Rotate secret" description={`Replace the secret saved for ${conn.name}.`} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) m.mutate(); }}>
        <p className="text-sm text-muted-foreground">The old secret stops working for the AI as soon as you save. We cannot show it, only replace it.</p>
        {basic ? (
          <div className="grid gap-4 sm:grid-cols-2"><TextField label="Username" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /><TextField label="Password" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></div>
        ) : <TextField label="New secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" className="font-mono text-sm" />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!ok || m.isPending}>{m.isPending && <Spinner />}Rotate secret</Button>
        </div>
      </form>
    </Modal>
  );
}

/** One connection as a row; used by the Connections screen. */
function ConnectionRow({ c, canEdit, onEdit, onRotate, onDelete }: { c: Connection; canEdit: boolean; onEdit: () => void; onRotate: () => void; onDelete: () => void }) {
  const last = useConnectionTests().get(c.id);
  const test = useMutation({
    meta: { skipInvalidate: true },
    mutationFn: async () => { const r = await tl.testConnection(c.id); rememberConnectionTest(c.id, r); return r; },
    onSuccess: (r) => (r.ok ? toast.success(`${c.name} answered`, { description: `Status ${r.status} in ${r.latencyMs} ms` }) : toast.error(`${c.name}: the test did not work`)),
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <motion.li layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2 }} className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"><Plug className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display font-semibold">{c.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{c.baseUrl}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{AUTH_LABEL[c.authType]}</Badge>
            {c.authType !== "none" && <Badge variant={c.hasSecret ? "success" : "warning"}>{c.hasSecret ? "Secret saved" : "No secret"}</Badge>}
            {last ? <Badge variant={last.result.ok ? "success" : "destructive"}>{last.result.ok ? `Test passed, ${last.result.latencyMs} ms` : "Test failed"}</Badge> : <Badge variant="outline">Not tested yet</Badge>}
          </div>
        </div>
      </div>
      {last && !last.result.ok && <ConnectionTestResult result={last.result} />}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? <Spinner /> : <Zap />}Test connection</Button>
        {canEdit && <>
          <Button variant="outline" size="sm" onClick={onEdit}><Pencil />Edit</Button>
          {c.authType !== "none" && <Button variant="outline" size="sm" onClick={onRotate}><KeyRound />Rotate secret</Button>}
          <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDelete}><Trash2 />Delete</Button>
        </>}
      </div>
    </motion.li>
  );
}

type Dlg = { kind: "new" } | { kind: "edit" | "rotate" | "delete"; c: Connection } | null;

export default function ConnectionsPage() {
  const { isAdmin } = useRole();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [delErr, setDelErr] = useState<string>();
  const q = useQuery({ queryKey: toolKeys.connections, queryFn: tl.connections, enabled: isAdmin });
  const del = useMutation({
    mutationFn: (c: Connection) => tl.deleteConnection(c.id),
    onSuccess: () => { toast.success("Connection deleted"); setDlg(null); setDelErr(undefined); },
    onError: (e) => { const m = inUseMessage(e); if (m) setDelErr(m); else { toast.error(errMsg(e)); setDlg(null); } },
  });
  const close = () => { setDlg(null); setDelErr(undefined); };

  return (
    <section aria-labelledby="h" className="max-w-3xl space-y-5">
      <PageHeader title="Connections" subtitle="The systems your AI tools talk to, and how they sign in. Secrets are stored encrypted and are never shown again."
        actions={isAdmin ? <Button onClick={() => setDlg({ kind: "new" })}><Plus />New connection</Button> : undefined} />
      {!isAdmin && <RoleNotice what="connections" />}
      {isAdmin && (q.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading connections">{[0, 1].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      ) : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 ? (
        <Empty icon={<ShieldCheck className="size-6" />} title="No connections yet" body="A connection tells the AI where your system lives and how to sign in. Add one, then build tools on top of it." action={<Button onClick={() => setDlg({ kind: "new" })}><Plus />Create a connection</Button>} />
      ) : (
        <ul className="space-y-3"><AnimatePresence initial={false}>{q.data.map((c) => (
          <ConnectionRow key={c.id} c={c} canEdit onEdit={() => setDlg({ kind: "edit", c })} onRotate={() => setDlg({ kind: "rotate", c })} onDelete={() => { setDelErr(undefined); setDlg({ kind: "delete", c }); }} />
        ))}</AnimatePresence></ul>
      ))}

      {dlg?.kind === "new" && <Modal title="New connection" onClose={close}><ConnectionForm onDone={() => close()} onCancel={close} /></Modal>}
      {dlg?.kind === "edit" && <Modal title="Edit connection" onClose={close}><ConnectionForm initial={dlg.c} onDone={() => close()} onCancel={close} /></Modal>}
      {dlg?.kind === "rotate" && <RotateSecret conn={dlg.c} onClose={close} />}
      {dlg?.kind === "delete" && (
        <ConfirmModal danger title={`Delete ${dlg.c.name}?`} confirm="Delete connection" busy={del.isPending} onConfirm={() => del.mutate(dlg.c)} onClose={close}
          body={<div className="space-y-3"><p>A connection cannot be deleted while a tool still uses it. If one does, you will be told which agent: change or remove those tools first. This cannot be undone.</p>
            {delErr && <Alert variant="destructive"><TriangleAlert /><AlertDescription>{delErr}</AlertDescription></Alert>}</div>} />
      )}
      {isAdmin && q.isSuccess && q.data.length > 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4" />Test results are kept for this browser session only.</p>}
    </section>
  );
}
