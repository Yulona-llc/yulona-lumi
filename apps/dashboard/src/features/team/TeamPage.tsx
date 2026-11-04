import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus, UserPlus } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { ag, errMsg, type Invitation, type Role } from "../common/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Stagger, StaggerItem } from "@/components/motion";
import { Badge, ConfirmModal, Empty, ErrorState, fmtDate, Loading, Modal, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";
import { CopyButton, initials } from "../settings/parts";

const ROLES: Role[] = ["owner", "admin", "agent", "viewer"];
const rank = { viewer: 0, agent: 1, admin: 2, owner: 3 } as const;
const ROLE_HINT: Record<Role, string> = { owner: "Everything, including billing", admin: "Manages settings and agents", agent: "Works the inbox", viewer: "Read only" };
const COLS = "lg:grid-cols-[minmax(0,1.5fr)_12.5rem_9rem_5.5rem]";

export default function TeamPage() {
  const { isAdmin, role } = useRole();
  const me = useAuth().session?.user.id;
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: ag.users });
  const invs = useQuery({ queryKey: ["invitations"], queryFn: ag.invitations, enabled: isAdmin });
  const [invite, setInvite] = useState(false);
  const [revoke, setRevoke] = useState<Invitation | null>(null);
  const upd = useMutation({
    mutationFn: (v: { id: string; b: { role?: Role; status?: "active" | "disabled" }; msg: string }) => ag.updateUser(v.id, v.b),
    onSuccess: (_d, v) => { toast.success(v.msg); void qc.invalidateQueries({ queryKey: ["users"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rv = useMutation({
    mutationFn: (id: string) => ag.revokeInvite(id),
    onSuccess: () => { setRevoke(null); toast.success("Invitation revoked"); void qc.invalidateQueries({ queryKey: ["invitations"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const grantable = ROLES.filter((r) => rank[r] <= rank[role]);
  return (
    <div>
      <PageHeader title="Team" subtitle="Owners and admins manage everything, agents work the inbox, viewers read only." actions={isAdmin && <Button onClick={() => setInvite(true)}><UserPlus />Invite member</Button>} />
      {!isAdmin && <RoleNotice what="managing the team" />}
      {users.isPending ? <Loading /> : users.isError ? <ErrorState error={users.error} retry={() => void users.refetch()} /> : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className={`hidden gap-4 border-b bg-muted/50 px-4 py-2.5 text-xs font-medium text-muted-foreground lg:grid ${COLS}`} aria-hidden><span>Member</span><span>Role and status</span><span>Last sign-in</span><span /></div>
          <Stagger className="divide-y">
            {users.data.map((u) => {
              const self = u.id === me;
              const locked = !isAdmin || self || rank[u.role] > rank[role] || (role !== "owner" && rank[u.role] >= rank[role]);
              return (
                <StaggerItem key={u.id} className={`grid items-center gap-x-4 gap-y-2.5 px-4 py-3.5 lg:py-3 ${COLS}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-10"><AvatarFallback>{initials(u.name)}</AvatarFallback></Avatar>
                    <div className="min-w-0"><p className="truncate font-medium">{u.name}{self && <span className="font-normal text-muted-foreground"> (you)</span>}</p><p className="truncate text-sm text-muted-foreground">{u.email}</p></div>
                  </div>
                  <div className="flex items-center gap-2">
                    {locked ? <Badge color="gray">{u.role}</Badge> : (
                      <Select value={u.role} onValueChange={(v) => upd.mutate({ id: u.id, b: { role: v as Role }, msg: `${u.name} is now ${v}` })}>
                        <SelectTrigger aria-label={`Role for ${u.name}`} className="w-full lg:w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>{grantable.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                      </Select>)}
                    <Badge color={u.status === "active" ? "green" : "gray"}>{u.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground"><span className="lg:hidden">Last sign-in: </span>{fmtDate(u.lastLoginAt)}</p>
                  <div className="lg:text-right">{!locked && <Button variant="outline" size="sm" onClick={() => upd.mutate({ id: u.id, b: { status: u.status === "active" ? "disabled" : "active" }, msg: u.status === "active" ? `Disabled ${u.name}` : `Enabled ${u.name}` })}>{u.status === "active" ? "Disable" : "Enable"}<span className="sr-only"> {u.name}</span></Button>}</div>
                </StaggerItem>);
            })}
          </Stagger>
        </div>)}
      {isAdmin && (
        <div className="mt-8">
          <h2 className="mb-3 font-display text-lg font-semibold">Invitations</h2>
          {invs.isPending ? <Loading rows={2} /> : invs.isError ? <ErrorState error={invs.error} retry={() => void invs.refetch()} /> : invs.data.length === 0 ? <Empty icon={<MailPlus className="size-6" />} title="No invitations" body="Invite a teammate by email. Links are valid for 7 days." /> : (
            <ul className="divide-y overflow-hidden rounded-2xl border bg-card">{invs.data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 font-medium"><span className="truncate">{i.email}</span><Badge color={i.status === "pending" ? "blue" : "gray"}>{i.status}</Badge></p><p className="text-sm text-muted-foreground">{i.role} · expires {fmtDate(i.expiresAt)}</p></div>
                {i.status === "pending" && <Button variant="outline" size="sm" onClick={() => setRevoke(i)}>Revoke<span className="sr-only"> invitation for {i.email}</span></Button>}
              </li>))}</ul>)}
        </div>)}
      {invite && <Invite roles={grantable.filter((r) => r !== "owner" || role === "owner")} onClose={() => setInvite(false)} onDone={() => void qc.invalidateQueries({ queryKey: ["invitations"] })} />}
      {revoke && <ConfirmModal danger title="Revoke invitation?" body={<>The link sent to {revoke.email} will stop working.</>} confirm="Revoke" busy={rv.isPending} onConfirm={() => rv.mutate(revoke.id)} onClose={() => setRevoke(null)} />}
    </div>
  );
}

function Invite({ roles, onClose, onDone }: { roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(roles.includes("agent") ? "agent" : roles[0]!);
  const m = useMutation({
    mutationFn: () => ag.invite({ email: email.trim(), role }),
    onSuccess: (r) => { toast.success(r.emailSent ? `Invitation sent to ${r.email}` : "Invitation created"); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Modal title="Invite member" description="They get an email with a link valid for 7 days." onClose={onClose}>
      {m.isSuccess ? (
        <div className="space-y-3"><p role="status">{m.data.emailSent ? `Invitation emailed to ${m.data.email}.` : "Invitation created, but the email could not be sent."}</p>
          {m.data.inviteUrl && <><p className="text-sm text-muted-foreground">Development link:</p><code className="block break-all rounded-xl bg-muted p-2.5 font-mono text-xs">{m.data.inviteUrl}</code></>}
          <div className="flex justify-end gap-2">{m.data.inviteUrl && <CopyButton text={m.data.inviteUrl} what="Link copied" size="default" label="Copy link" />}<Button onClick={onClose}>Done</Button></div></div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (email.trim()) m.mutate(); }}>
          <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
          <div className="grid gap-1.5">
            <span className="text-sm font-medium" id="role-l">Role</span>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger aria-labelledby="role-l"><SelectValue /></SelectTrigger>
              <SelectContent>{roles.map((r) => <SelectItem key={r} value={r}><span className="font-medium">{r}</span><span className="ml-2 text-muted-foreground">{ROLE_HINT[r]}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || !email.trim()}>{m.isPending && <Spinner />}Send invite</Button></div>
        </form>)}
    </Modal>
  );
}
