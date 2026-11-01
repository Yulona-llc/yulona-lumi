import { lazy, Suspense, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { Info } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan, type Perm } from "@/auth/permissions";
import { PageHeader } from "@/components/common";

const Providers = lazy(() => import("@/features/catalogue/ProvidersTab"));
const Rates = lazy(() => import("@/features/catalogue/RatesTab"));
const Plans = lazy(() => import("@/features/catalogue/PlansTab"));
const Packs = lazy(() => import("@/features/catalogue/PacksTab"));

const tabs = [["providers", "Providers"], ["rates", "Model rates"], ["plans", "Plan allowances"], ["packs", "Credit packs"]] as const;

/** `/billing/*`: which AI provider answers customers, what each model costs in credits, what every plan includes, purchasable packs. */
function Page({ perm, children }: { perm: Perm; children: ReactNode }) {
  const { can } = useAuth();
  const ro = !can(perm);
  return (
    <>
      {ro && <p role="note" className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/60 px-3 py-2 text-sm text-muted-foreground"><Info className="size-4 shrink-0" aria-hidden />Read only. {whoCan(perm)} to edit this.</p>}
      <fieldset disabled={ro} className="contents min-w-0">{children}</fieldset>
    </>
  );
}

export default function BillingCredits() {
  return (
    <div className="space-y-5">
      <PageHeader title="Billing and credits" subtitle="Which AI provider answers customers, what each model costs in credits, and what every plan includes." />
      <nav aria-label="Billing sections" className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {tabs.map(([to, l]) => <NavLink key={to} to={`/billing/${to}`} className={({ isActive }) => `flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-sm font-medium ${isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{l}</NavLink>)}
      </nav>
      <Suspense fallback={<div role="status" className="space-y-3"><span className="sr-only">Loading…</span><Skeleton className="h-32" /><Skeleton className="h-32" /></div>}>
        <Routes>
          <Route index element={<Navigate to="/billing/providers" replace />} />
          <Route path="providers" element={<Page perm="editProviders"><Providers /></Page>} />
          <Route path="rates" element={<Page perm="editCatalogue"><Rates /></Page>} />
          <Route path="plans" element={<Page perm="editCatalogue"><Plans /></Page>} />
          <Route path="packs" element={<Page perm="editCatalogue"><Packs /></Page>} />
          <Route path="*" element={<Navigate to="/billing/providers" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
