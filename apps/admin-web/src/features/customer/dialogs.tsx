import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { ImpersonateResult } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { Modal, Select, Spinner, TextArea, TextField } from "@/components/common";
import { errMsg } from "@/lib/errors";

/** Starts an audited impersonation. Read-only is the default; write mode is owner-only and says so. The one-time code opens the customer dashboard. */
export function ImpersonateDialog({ tenantId, tenantName, onClose }: { tenantId: string; tenantName: string; onClose: () => void }) {
  const { can } = useAuth();
  const [reason, setReason] = useState("");
  const [userId, setUserId] = useState("");
  const [write, setWrite] = useState(false);
  const [result, setResult] = useState<ImpersonateResult | null>(null);
  const users = useQuery({ queryKey: keys.tenantUsers(tenantId), queryFn: () => adminApi.tenantUsers(tenantId) });
  const start = useMutation({
    mutationFn: () => adminApi.impersonate(tenantId, { reason: reason.trim(), readOnly: !write, ...(userId ? { userId } : {}) }),
    onSuccess: (r) => { setResult(r); window.open(r.customerUrl, "_blank", "noopener"); },
  });
  const end = useMutation({ mutationFn: () => adminApi.endImpersonation(result!.sessionId), onSuccess: () => { toast.success("Session ended"); onClose(); }, onError: (e) => toast.error(errMsg(e)) });

  if (result) {
    return (
      <Modal title="Impersonation started" description="The customer dashboard opens in a new tab." onClose={onClose}>
        <div className="space-y-4 text-sm">
          <Alert variant={result.readOnly ? "info" : "warning"} role="status"><div>
            <p className="font-semibold">{result.readOnly ? "Read-only session" : "Write mode session"} as {result.user.email}</p>
            <p className="text-muted-foreground">{result.tenant.name}. The one-time link works for {result.codeExpiresIn} seconds and the session lasts 15 minutes. Every action is audited.</p>
          </div></Alert>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={end.isPending} onClick={() => end.mutate()}>{end.isPending && <Spinner />}End session now</Button>
            <Button asChild><a href={result.customerUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />Open customer dashboard</a></Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Impersonate ${tenantName}`} description="Signs you in to their dashboard as one of their users. Reading conversations happens only this way, and it is logged." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
        {start.isError && <Alert variant="destructive">{errMsg(start.error)}</Alert>}
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={500} rows={3} placeholder="Ticket number or why you need to look" hint="5 to 500 characters. Stored in the audit log and shown to other admins." />
        <Select label="Sign in as" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">The workspace owner</option>
          {users.data?.items.filter((u) => u.status === "active").map((u) => <option key={u.id} value={u.id}>{u.email} ({u.role})</option>)}
        </Select>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Mode</legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent/50">
            <input type="radio" name="mode" checked={!write} onChange={() => setWrite(false)} className="mt-1 accent-[var(--primary)]" />
            <span><span className="font-medium">Read-only</span><span className="block text-muted-foreground">Look around. Every change is blocked by the customer API.</span></span>
          </label>
          <label className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${can("impersonateWrite") ? "cursor-pointer has-[:checked]:border-destructive has-[:checked]:bg-destructive/5" : "cursor-not-allowed opacity-60"}`}>
            <input type="radio" name="mode" checked={write} disabled={!can("impersonateWrite")} onChange={() => setWrite(true)} className="mt-1 accent-[var(--primary)]" />
            <span><span className="flex items-center gap-1.5 font-medium"><ShieldAlert className="size-4 text-destructive" aria-hidden />Write mode</span><span className="block text-muted-foreground">{can("impersonateWrite") ? "You can change their data. Use only when the customer asked you to." : "Requires the owner role."}</span></span>
          </label>
        </fieldset>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={start.isPending || reason.trim().length < 5}>{start.isPending && <Spinner />}Start {write ? "write" : "read-only"} session</Button></div>
      </form>
    </Modal>
  );
}

export function PlanDialog({ tenantId, current, onClose }: { tenantId: string; current: string; onClose: () => void }) {
  const plans = useQuery({ queryKey: keys.plans, queryFn: adminApi.plans });
  const [plan, setPlan] = useState(current);
  const m = useMutation({ mutationFn: () => adminApi.setPlan(tenantId, plan), onSuccess: () => { toast.success("Plan changed"); onClose(); } });
  return (
    <Modal title="Change plan" description="Takes effect immediately and is audited. Credits and limits follow the new plan." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        {m.isError && <Alert variant="destructive">{errMsg(m.error)}</Alert>}
        <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>{plans.data?.map((p) => <option key={p.key} value={p.key}>{p.name}{p.key === current ? " (current)" : ""}</option>)}</Select>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || plan === current}>{m.isPending && <Spinner />}Change plan</Button></div>
      </form>
    </Modal>
  );
}

export function GrantDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const n = Number(credits);
  const ok = credits.trim() !== "" && Number.isFinite(n) && n !== 0 && reason.trim().length >= 3;
  const m = useMutation({ mutationFn: () => adminApi.grant(tenantId, n, reason.trim()), onSuccess: () => { toast.success(n > 0 ? "Credits granted" : "Credits adjusted"); onClose(); } });
  return (
    <Modal title="Grant or adjust credits" description="A positive number adds bought-style credits, a negative number removes them. A reason is required and audited." onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) m.mutate(); }}>
        {m.isError && <Alert variant="destructive">{errMsg(m.error)}</Alert>}
        <TextField label="Credits" inputMode="decimal" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="500 or -100" required />
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!ok || m.isPending}>{m.isPending && <Spinner />}Apply</Button></div>
      </form>
    </Modal>
  );
}
