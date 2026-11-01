import { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { lazyWithReload as lazy } from "@/lib/lazy";
import { useAuth } from "@/auth/AuthProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Login = lazy(() => import("@/pages/Login"));
const Restricted = lazy(() => import("@/pages/Restricted"));
const Shell = lazy(() => import("@/components/Shell"));
const Overview = lazy(() => import("@/pages/Overview"));
const Customers = lazy(() => import("@/pages/Customers"));
const CustomerDetail = lazy(() => import("@/pages/CustomerDetail"));
const Attention = lazy(() => import("@/pages/Attention"));
const Operations = lazy(() => import("@/pages/Operations"));
const BillingCredits = lazy(() => import("@/pages/BillingCredits"));
const Flags = lazy(() => import("@/pages/Flags"));
const Audit = lazy(() => import("@/pages/Audit"));
const Admins = lazy(() => import("@/pages/Admins"));
const Account = lazy(() => import("@/pages/Account"));
const NotFound = lazy(() => import("@/pages/NotFound"));

function FullPageSpinner({ label }: { label: string }) {
  return <div role="status" className="grid h-full place-items-center text-muted-foreground"><div className="flex items-center gap-3"><span className="spinner" aria-hidden /><span>{label}…</span></div></div>;
}

/** Session gate: reload restores the session from the refresh cookie; anonymous shows sign-in at whatever URL was open. */
export function App() {
  const { status, admin } = useAuth();
  if (status === "loading") return <FullPageSpinner label="Restoring your session" />;
  return (
    <ErrorBoundary fullPage>
      <Suspense fallback={<FullPageSpinner label="Loading" />}>
        {status === "anonymous" ? <Login /> : admin?.restricted ? <Restricted /> : (
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Overview />} />
              <Route path="customers" element={<Customers />} />
              <Route path="customers/:id" element={<CustomerDetail />} />
              <Route path="attention" element={<Attention />} />
              <Route path="operations" element={<Operations />} />
              <Route path="billing/*" element={<BillingCredits />} />
              <Route path="flags" element={<Flags />} />
              <Route path="audit" element={<Audit />} />
              <Route path="admins" element={<Admins />} />
              <Route path="account" element={<Account />} />
              <Route path="login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        )}
      </Suspense>
    </ErrorBoundary>
  );
}
