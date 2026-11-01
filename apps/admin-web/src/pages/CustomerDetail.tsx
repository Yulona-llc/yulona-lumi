import { lazy, Suspense, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Coins, Copy, MoreHorizontal, Pencil, Trash2, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { Gated, HealthBadge, StatusBadge } from "@/components/bits";
import { ConfirmModal, ErrorState, Loading, Modal, Spinner, TextField } from "@/components/common";
import { titleCase } from "@/lib/format";
import { errMsg } from "@/lib/errors";
import { GrantDialog, ImpersonateDialog, PlanDialog } from "@/features/customer/dialogs";

const OverviewTab = lazy(() => import("@/features/customer/OverviewTab"));
const TeamTab = lazy(() => import("@/features/customer/TeamTab"));
const SetupTab = lazy(() => import("@/features/customer/SetupTab"));
const IssuesTab = lazy(() => import("@/features/customer/IssuesTab"));
const UsageTab = lazy(() => import("@/features/customer/UsageTab"));
const BillingTab = lazy(() => import("@/features/customer/BillingTab"));
const TimelineTab = lazy(() => import("@/features/customer/TimelineTab"));
const FlagsTab = lazy(() => import("@/features/customer/FlagsTab"));
const AuditTab = lazy(() => import("@/features/customer/AuditTab"));

export const TABS = [
  ["overview", "Overview"], ["team", "Team"], ["setup", "Setup"], ["issues", "Issues"], ["usage", "Usage and credits"],
  ["billing", "Billing"], ["timeline", "Timeline"], ["flags", "Flags"], ["audit", "Audit"],
] as const;
type TabId = (typeof TABS)[number][0];

function RenameDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [v, setV] = useState(name);
  const m = useMutation({ mutationFn: () => adminApi.renameTenant(id, v.trim()), onSuccess: () => { toast.success("Customer renamed"); onClose(); } });
  return (
    <Modal title="Rename customer" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <TextField label="Workspace name" value={v} onChange={(e) => setV(e.target.value)} required maxLength={120} error={m.isError ? errMsg(m.error) : undefined} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || !v.trim() || v.trim() === name}>{m.isPending && <Spinner />}Save</Button></div>
      </form>
    </Modal>
  );
}

export default function CustomerDetail() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const tab = (TABS.find(([t]) => t === sp.get("tab"))?.[0] ?? "overview") as TabId;
  const q = useQuery({ queryKey: keys.tenant(id), queryFn: () => adminApi.tenant(id), enabled: !!id });
  const [dlg, setDlg] = useState<null | "impersonate" | "plan" | "grant" | "rename" | "suspend" | "restore" | "delete">(null);
  const act = useMutation({
    mutationFn: (a: "suspend" | "unsuspend" | "restore" | "delete") => (a === "delete" ? adminApi.deleteTenant(id) : adminApi.tenantAction(id, a)),
    onSuccess: () => { setDlg(null); toast.success("Customer updated"); }, onError: (e) => toast.error(errMsg(e)),
  });

  if (q.isPending) return <Loading label="Loading customer" rows={4} />;
  if (q.isError) return <div className="space-y-3"><Button asChild variant="ghost" size="sm"><Link to="/customers"><ArrowLeft aria-hidden />Customers</Link></Button><ErrorState error={q.error} retry={() => void q.refetch()} /></div>;
  const d = q.data;
  const t = d.tenant;
  const life = can("tenantLifecycle");
  const setTab = (v: string) => setSp((cur) => { const n = new URLSearchParams(cur); if (v === "overview") n.delete("tab"); else n.set("tab", v); return n; }, { replace: true });

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2"><Link to="/customers"><ArrowLeft aria-hidden />Customers</Link></Button>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="min-w-0 break-words font-display text-2xl font-semibold tracking-tight sm:text-[1.7rem]">{t.name}</h1>
            <StatusBadge status={t.status} /><HealthBadge health={d.health} />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{titleCase(t.plan)} plan</span>
            <span>{d.owner ? `${d.owner.name} (${d.owner.email})` : "No owner"}</span>
            <button type="button" className="inline-flex items-center gap-1 font-mono text-xs hover:text-foreground" onClick={() => void navigator.clipboard?.writeText(t.id).then(() => toast.success("ID copied"))} aria-label="Copy customer ID"><Copy className="size-3" aria-hidden />{t.id.slice(0, 8)}</button>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 max-sm:[&>*]:flex-1">
          <Gated allowed={can("impersonate")} reason={whoCan("impersonate")}><Button onClick={() => setDlg("impersonate")} disabled={t.status === "deleted"}><UserRoundCog aria-hidden />Impersonate</Button></Gated>
          <Gated allowed={can("changePlan")} reason={whoCan("changePlan")}><Button variant="outline" onClick={() => setDlg("plan")}>Change plan</Button></Gated>
          <Gated allowed={can("grantCredits")} reason={whoCan("grantCredits")}><Button variant="outline" onClick={() => setDlg("grant")}><Coins aria-hidden />Grant credits</Button></Gated>
          {t.status === "active" && <Gated allowed={life} reason={whoCan("tenantLifecycle")}><Button variant="outline" className="text-destructive" onClick={() => setDlg("suspend")}>Suspend</Button></Gated>}
          {t.status === "suspended" && <Gated allowed={life} reason={whoCan("tenantLifecycle")}><Button variant="outline" onClick={() => act.mutate("unsuspend")} disabled={act.isPending}>Restore access</Button></Gated>}
          {t.status === "deleted" && <Gated allowed={life} reason={whoCan("tenantLifecycle")}><Button variant="outline" onClick={() => setDlg("restore")}>Restore customer</Button></Gated>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!life} onSelect={() => setDlg("rename")}><Pencil />Rename{!life && " (owner only)"}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive disabled={!life || t.status === "deleted"} onSelect={() => setDlg("delete")}><Trash2 />Delete customer{!life && " (owner only)"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="h-auto w-max min-w-full justify-start gap-0.5 rounded-none border-b bg-transparent p-0">
            {TABS.map(([v, l]) => (
              <TabsTrigger key={v} value={v} className="relative min-h-11 flex-none rounded-none border-b-2 border-transparent px-3.5 text-sm data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">
                {l}{v === "issues" && d.errorCount7d > 0 && <span className="ml-1.5 rounded-full bg-destructive/15 px-1.5 text-xs font-semibold tabular-nums text-destructive" aria-label={`${d.errorCount7d} errors in the last 7 days`}>{d.errorCount7d}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      <Suspense fallback={<Loading rows={3} />}>
        {tab === "overview" && <OverviewTab id={id} d={d} onTab={setTab} />}
        {tab === "team" && <TeamTab id={id} />}
        {tab === "setup" && <SetupTab id={id} />}
        {tab === "issues" && <IssuesTab id={id} />}
        {tab === "usage" && <UsageTab id={id} d={d} onGrant={() => setDlg("grant")} />}
        {tab === "billing" && <BillingTab id={id} d={d} onPlan={() => setDlg("plan")} />}
        {tab === "timeline" && <TimelineTab id={id} />}
        {tab === "flags" && <FlagsTab id={id} />}
        {tab === "audit" && <AuditTab id={id} />}
      </Suspense>

      {dlg === "impersonate" && <ImpersonateDialog tenantId={id} tenantName={t.name} onClose={() => setDlg(null)} />}
      {dlg === "plan" && <PlanDialog tenantId={id} current={t.plan} onClose={() => setDlg(null)} />}
      {dlg === "grant" && <GrantDialog tenantId={id} onClose={() => setDlg(null)} />}
      {dlg === "rename" && <RenameDialog id={id} name={t.name} onClose={() => setDlg(null)} />}
      {dlg === "suspend" && <ConfirmModal danger title="Suspend this customer?" body={<>Everyone in <strong>{t.name}</strong> is signed out and blocked until you restore access.</>} confirm="Suspend" busy={act.isPending} onConfirm={() => act.mutate("suspend")} onClose={() => setDlg(null)} />}
      {dlg === "restore" && <ConfirmModal title="Restore this customer?" body={<><strong>{t.name}</strong> becomes usable again. Customers deleted more than 30 days ago cannot be restored.</>} confirm="Restore" busy={act.isPending} onConfirm={() => act.mutate("restore")} onClose={() => setDlg(null)} />}
      {dlg === "delete" && <ConfirmModal danger title="Delete this customer?" body={<>Soft-deletes <strong>{t.name}</strong>: access stops now. You can restore it within 30 days.</>} confirm="Delete customer" busy={act.isPending}
        onConfirm={() => act.mutate("delete", { onSuccess: () => nav("/customers") })} onClose={() => setDlg(null)} />}
    </div>
  );
}
