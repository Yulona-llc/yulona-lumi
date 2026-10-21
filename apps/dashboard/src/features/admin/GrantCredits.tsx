import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "../common/api";
import { Badge, Modal, TextArea, TextField } from "../common/ui";
import { fmtCredits } from "../usage/api";
import { adminCreditKeys, creditsAdmin } from "./creditsApi";

/** Tenant detail card: credit balance plus the "Adjust credits" action (positive grants, negative deducts; reason is audited). */
export function TenantCreditsCard({ id }: { id: string }) {
  const q = useQuery({ queryKey: adminCreditKeys.tenant(id), queryFn: () => creditsAdmin.tenantCredits(id), retry: false });
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const n = Number(credits);
  const ok = credits.trim() !== "" && Number.isFinite(n) && n !== 0 && reason.trim().length >= 3 && reason.trim().length <= 300;
  const grant = useMutation({
    mutationFn: () => creditsAdmin.grant(id, n, reason.trim()),
    onSuccess: () => { setOpen(false); setCredits(""); setReason(""); toast.success("Credits adjusted"); },
  });
  const c = q.data;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">AI credits</h2>
        <Button variant="outline" onClick={() => setOpen(true)} disabled={q.isError}><Sparkles aria-hidden />Adjust credits</Button>
      </div>
      {q.isPending ? <p className="text-sm text-muted-foreground">Loading credits…</p>
        : q.isError ? <p className="text-sm text-muted-foreground">Credits are not available for this tenant: {errMsg(q.error)}</p>
        : !c?.enabled ? <p className="text-sm text-muted-foreground">Credits are not charged on this deployment.</p>
        : (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div><dt className="text-sm text-muted-foreground">Remaining</dt><dd className="font-display text-2xl font-semibold tabular-nums">{c.unlimited ? "Unlimited" : fmtCredits(c.remainingMicro)}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Used this month</dt><dd className="font-display text-2xl font-semibold tabular-nums">{fmtCredits(c.usedMicro + c.topupUsedMicro)}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Top-up balance</dt><dd className="font-display text-2xl font-semibold tabular-nums">{fmtCredits(c.topupMicro)}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Status</dt><dd className="pt-1"><Badge color={c.status === "ok" ? "green" : c.status === "warning" ? "amber" : "red"}>{c.status}</Badge></dd></div>
          </dl>
        )}
      {open && (
        <Modal title="Adjust credits" description="Adds to the top-up balance. Use a negative number to deduct." onClose={() => setOpen(false)}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) grant.mutate(); }}>
            {grant.isError && <Alert variant="destructive">{errMsg(grant.error)}</Alert>}
            <TextField label="Credits (negative deducts)" inputMode="decimal" value={credits} onChange={(e) => setCredits(e.target.value)} required hint="Up to 6 decimals, not zero." />
            <TextArea label="Reason (3 to 300 characters)" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required hint="Saved in the platform audit log. Owners see it when credits are granted." />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!ok || grant.isPending}>{grant.isPending && <Loader2 className="animate-spin" aria-hidden />}Adjust credits</Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
