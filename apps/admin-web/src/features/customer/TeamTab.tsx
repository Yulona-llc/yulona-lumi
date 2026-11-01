import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { Gated, Section, StatusBadge } from "@/components/bits";
import { ErrorState, Loading } from "@/components/common";
import { ago, fmtDate } from "@/lib/format";
import { errMsg } from "@/lib/errors";

export default function TeamTab({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: keys.tenantUsers(id), queryFn: () => adminApi.tenantUsers(id) });
  const resend = useMutation({
    mutationFn: (inv: string) => adminApi.resendInvite(id, inv),
    onSuccess: (r) => toast.success(r.emailSent ? "Invitation email sent" : "New link created, but the email could not be sent"), onError: (e) => toast.error(errMsg(e)),
  });
  if (q.isPending) return <Loading rows={3} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const { items, invitations } = q.data;
  return (
    <div className="space-y-4">
      <Section title={`Team members (${items.length})`} hint="People who sign in to this workspace. Contacts are not shown.">
        <div className="-m-4 overflow-x-auto">
          <Table className="min-w-[36rem]">
            <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Last sign-in</TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell><p className="font-medium">{u.name}</p><p className="text-xs text-muted-foreground">{u.email}</p></TableCell>
                  <TableCell className="capitalize">{u.role}</TableCell>
                  <TableCell><div className="flex flex-wrap gap-1"><StatusBadge status={u.status} />{u.locked && <Badge variant="warning"><Lock aria-hidden />Locked</Badge>}</div></TableCell>
                  <TableCell title={fmtDate(u.lastLoginAt)}>{ago(u.lastLoginAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
      <Section title={`Invitations (${invitations.length})`} hint="Resending issues a new 7-day link and emails it. The link is never shown here.">
        {invitations.length === 0 ? <p className="text-sm text-muted-foreground">No invitations.</p> : (
          <ul className="divide-y">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{i.email}</p><p className="text-xs text-muted-foreground">{i.role} · sent {ago(i.createdAt)} · expires {fmtDate(i.expiresAt)}</p></div>
                <Badge variant={i.status === "pending" ? "info" : "secondary"}>{i.status}</Badge>
                {i.status === "pending" && <Gated allowed={can("resendInvite")} reason={whoCan("resendInvite")}><Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate(i.id)}><Mail aria-hidden />Resend</Button></Gated>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <p className="text-xs text-muted-foreground">There is no customer password-reset flow yet, so resetting a customer's password is not offered here.</p>
    </div>
  );
}
