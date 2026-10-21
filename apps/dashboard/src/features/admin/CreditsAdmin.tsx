import { lazy, Suspense } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "../common/ui";

const Providers = lazy(() => import("./ProvidersTab"));
const Rates = lazy(() => import("./RatesTab"));
const Plans = lazy(() => import("./PlansTab"));
const Packs = lazy(() => import("./PacksTab"));

const tabs = [["providers", "Providers"], ["rates", "Model rates"], ["plans", "Plan allowances"], ["packs", "Credit packs"]] as const;

/** `/admin/credits/*`: provider profiles, per-model rates, monthly allowances per plan and purchasable packs. */
export default function CreditsAdmin() {
  return (
    <div className="space-y-5">
      <PageHeader title="Credits and models" subtitle="Which AI provider answers customers, what each model costs in credits, and what every plan includes." />
      <nav aria-label="Credits sections" className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {tabs.map(([to, l]) => <NavLink key={to} to={`/admin/credits/${to}`} className={({ isActive }) => `flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-sm font-medium ${isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{l}</NavLink>)}
      </nav>
      <Suspense fallback={<div role="status" className="space-y-3"><span className="sr-only">Loading…</span><Skeleton className="h-32" /><Skeleton className="h-32" /></div>}>
        <Routes>
          <Route index element={<Navigate to="/admin/credits/providers" replace />} />
          <Route path="providers" element={<Providers />} />
          <Route path="rates" element={<Rates />} />
          <Route path="plans" element={<Plans />} />
          <Route path="packs" element={<Packs />} />
          <Route path="*" element={<Navigate to="/admin/credits/providers" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
