import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { ag, errMsg } from "../common/api";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Badge, ErrorState, Loading, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";
import { DirtyDot, FormSection, StickyBar } from "./parts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function AccountPage() {
  const { session, refreshProfile } = useAuth();
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tenant"], queryFn: ag.tenant });
  const [name, setName] = useState("");
  useEffect(() => { if (q.data) setName(q.data.name); }, [q.data]);
  const m = useMutation({
    mutationFn: () => ag.renameTenant(name.trim()),
    onSuccess: async () => { await refreshProfile(); toast.success("Workspace renamed"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (q.isPending) return <div role="status" aria-live="polite" className="space-y-4"><span className="sr-only">Loading…</span><Skeleton className="h-8 w-40" /><Skeleton className="h-48" /><Skeleton className="h-56" /></div>;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const t = q.data;
  const dirty = !!name.trim() && name.trim() !== t.name;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Account" subtitle="Your workspace name, plan and how much of it you have used." />
      {!isAdmin && <RoleNotice what="renaming the workspace" />}
      <div className="space-y-5">
        <form id="ws" onSubmit={(e) => { e.preventDefault(); if (dirty) m.mutate(); }}>
          <FormSection title="Workspace" description={`Signed in as ${session?.user.email} (${session?.user.role}).`} aside={<Badge color={t.status === "active" ? "green" : "amber"}>{t.status}</Badge>}>
            <TextField label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={100} />
          </FormSection>
        </form>
        <FormSection title={`Plan: ${t.plan.name}`} description="Usage this period. Limits warn you at 80%.">
          <ul className="space-y-4">{t.limits.map((l) => {
            const pct = l.limit ? Math.min(100, Math.round((l.used / l.limit) * 100)) : 0;
            return (
              <li key={l.metric}>
                <div className="flex justify-between gap-3 text-sm"><span className="capitalize">{l.metric.replaceAll("_", " ")}</span><span className="tabular-nums text-muted-foreground">{l.used.toLocaleString()} / {l.limit?.toLocaleString() ?? "unlimited"}</span></div>
                {l.limit !== null && <Progress value={pct} aria-label={`${l.metric} usage`} className={cn("mt-1.5", l.warning && "[&>div]:bg-warning")} />}
                {l.warning && <p className="mt-1 text-xs text-warning">Over 80% used.</p>}
              </li>);
          })}</ul>
        </FormSection>
      </div>
      {isAdmin && (
        <StickyBar show={dirty}>
          <DirtyDot />
          <Button type="button" variant="ghost" onClick={() => setName(t.name)}>Discard</Button>
          <Button type="submit" form="ws" disabled={m.isPending}>{m.isPending && <Spinner />}Save changes</Button>
        </StickyBar>
      )}
    </div>
  );
}
