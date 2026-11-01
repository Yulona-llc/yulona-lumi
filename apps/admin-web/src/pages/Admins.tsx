import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Lock, MoreHorizontal, ShieldCheck, UserPlus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { AdminRow, Role } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { roleLabel } from "@/auth/permissions";
import { StatusBadge } from "@/components/bits";
import { ConfirmModal, Empty, ErrorState, Loading, Modal, PageHeader, Select, Spinner, TextField } from "@/components/common";
import { ago, fmtDate } from "@/lib/format";
import { errMsg } from "@/lib/errors";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything: lifecycle, flags, admin accounts, write-mode impersonation.",
  support: "All reads, notes, tags, invitation resends, job retries, read-only impersonation.",
  billing: "All reads, credits, plan changes, plan limits, rates and credit packs.",
};

function TempPassword({ title, email, pw, onClose }: { title: string; email: string; pw: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <Alert variant="warning"><div><p className="font-semibold">Shown once</p><p className="text-muted-foreground">Send it to {email} through a secure channel. They must choose their own password at first sign-in.</p></div></Alert>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3"><code className="min-w-0 flex-1 break-all font-mono text-sm" data-testid="temp-password">{pw}</code>
          <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(pw).then(() => toast.success("Copied"))}><Copy aria-hidden />Copy</Button></div>
        <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (email: string, pw: string) => void }) {
  const [email, setEmail] = useState(""); const [name, setName] = useState(""); const [role, setRole] = useState<Role>("support");
  const m = useMutation({ mutationFn: () => adminApi.inviteAdmin({ email: email.trim(), name: name.trim(), role }), onSuccess: (r) => onCreated(r.email, r.temporaryPassword) });
  return (
    <Modal title="Invite an admin" description="Creates the account with a temporary password you pass on." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        {m.isError && <Alert variant="destructive">{errMsg(m.error)}</Alert>}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} hint={ROLE_HELP[role]}>{(Object.keys(roleLabel) as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}</Select>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending}>{m.isPending && <Spinner />}Create admin</Button></div>
      </form>
    </Modal>
  );
}

function EditDialog({ a, onClose }: { a: AdminRow; onClose: () => void }) {
  const [name, setName] = useState(a.name); const [role, setRole] = useState<Role>(a.role);
  const m = useMutation({ mutationFn: () => adminApi.updateAdmin(a.id, { ...(name.trim() !== a.name ? { name: name.trim() } : {}), ...(role !== a.role ? { role } : {}) }), onSuccess: () => { toast.success("Admin updated"); onClose(); } });
  return (
    <Modal title={`Edit ${a.email}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        {m.isError && <Alert variant="destructive">{errMsg(m.error)}</Alert>}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} hint={ROLE_HELP[role]}>{(Object.keys(roleLabel) as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}</Select>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || (name.trim() === a.name && role === a.role)}>{m.isPending && <Spinner />}Save</Button></div>
      </form>
    </Modal>
  );
}

type Pending = { kind: "deactivate" | "reset-2fa" | "reset-password"; a: AdminRow };

export default function Admins() {
  const { admin: me, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const owner = can("manageAdmins");
  const q = useQuery({ queryKey: keys.admins, queryFn: adminApi.admins, enabled: owner });
  const [invite, setInvite] = useState(sp.get("invite") === "1");
  const [edit, setEdit] = useState<AdminRow | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [secret, setSecret] = useState<{ title: string; email: string; pw: string } | null>(null);
  useEffect(() => { if (sp.get("invite")) setSp((c) => { const n = new URLSearchParams(c); n.delete("invite"); return n; }, { replace: true }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const run = useMutation({
    mutationFn: async (p: Pending) => {
      if (p.kind === "reset-password") return { pw: (await adminApi.resetAdminPassword(p.a.id)).temporaryPassword };
      await adminApi.adminAction(p.a.id, p.kind); return {};
    },
    onSuccess: (r, p) => {
      setPending(null);
      if ("pw" in r && r.pw) setSecret({ title: "New temporary password", email: p.a.email, pw: r.pw });
      else toast.success(p.kind === "deactivate" ? "Admin deactivated" : "Two-factor reset");
    },
    onError: (e) => { setPending(null); toast.error(errMsg(e)); },
  });
  const activate = useMutation({ mutationFn: (id: string) => adminApi.adminAction(id, "activate"), onSuccess: () => toast.success("Admin reactivated"), onError: (e) => toast.error(errMsg(e)) });

  if (!owner) return <div className="space-y-4"><PageHeader title="Admins" /><Empty icon={<Lock className="size-6" />} title="Owners only" body="Only owners can see and manage admin accounts. Change your own password and two-factor settings from the account menu." /></div>;
  return (
    <div className="space-y-4">
      <PageHeader title="Admins" subtitle="Who can sign in to this console. Role changes and deactivation apply on the next request."
        actions={<Button onClick={() => setInvite(true)}><UserPlus aria-hidden />Invite admin</Button>} />
      {q.isPending ? <Loading rows={4} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
        <div className="rounded-xl border bg-card">
          <ul className="divide-y">
            {q.data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                <div className="min-w-0 flex-1 basis-56"><p className="flex flex-wrap items-center gap-2 font-medium">{a.name}{a.id === me?.id && <Badge variant="outline">You</Badge>}</p><p className="truncate text-sm text-muted-foreground">{a.email}</p></div>
                <Badge variant={a.role === "owner" ? "default" : "secondary"}>{roleLabel[a.role]}</Badge>
                <StatusBadge status={a.status === "suspended" ? "deactivated" : a.status} />
                <Badge variant={a.twoFactorEnabled ? "success" : "outline"}><ShieldCheck aria-hidden />{a.twoFactorEnabled ? "2FA on" : "No 2FA"}</Badge>
                <span className="w-28 text-xs text-muted-foreground" title={fmtDate(a.lastLoginAt)}>{a.lastLoginAt ? `Signed in ${ago(a.lastLoginAt)}` : "Never signed in"}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.email}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEdit(a)}>Edit name or role</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPending({ kind: "reset-password", a })}>Reset password</DropdownMenuItem>
                    <DropdownMenuItem disabled={!a.twoFactorEnabled} onSelect={() => setPending({ kind: "reset-2fa", a })}>Reset two-factor</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {a.status === "active"
                      ? <DropdownMenuItem destructive disabled={a.id === me?.id} onSelect={() => setPending({ kind: "deactivate", a })}>Deactivate{a.id === me?.id ? " (not yourself)" : ""}</DropdownMenuItem>
                      : <DropdownMenuItem onSelect={() => activate.mutate(a.id)}>Reactivate</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">{(Object.keys(ROLE_HELP) as Role[]).map((r) => <p key={r}><span className="font-medium text-foreground">{roleLabel[r]}.</span> {ROLE_HELP[r]}</p>)}</div>

      {invite && <InviteDialog onClose={() => setInvite(false)} onCreated={(email, pw) => { setInvite(false); setSecret({ title: "Admin created", email, pw }); }} />}
      {edit && <EditDialog a={edit} onClose={() => setEdit(null)} />}
      {secret && <TempPassword {...secret} onClose={() => setSecret(null)} />}
      {pending && <ConfirmModal danger={pending.kind !== "reset-2fa"} busy={run.isPending} onClose={() => setPending(null)} onConfirm={() => run.mutate(pending)}
        title={pending.kind === "deactivate" ? "Deactivate this admin?" : pending.kind === "reset-2fa" ? "Reset two-factor?" : "Reset the password?"}
        confirm={pending.kind === "deactivate" ? "Deactivate" : "Reset"}
        body={pending.kind === "deactivate" ? <><strong>{pending.a.email}</strong> is signed out now and cannot sign in. The last active owner cannot be deactivated.</>
          : pending.kind === "reset-2fa" ? <>Removes the authenticator and recovery codes of <strong>{pending.a.email}</strong> and signs them out.</>
          : <>Creates a new temporary password for <strong>{pending.a.email}</strong>, signs them out everywhere and forces a change at next sign-in.</>} />}
    </div>
  );
}
