import { Suspense } from "react";
import { lazyWithReload as lazy } from "@/lib/lazy";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth/AuthProvider";
import { FullPageSpinner } from "./components/ui";
import { featureRoutes } from "./routes";
import { ErrorBoundary } from "./components/ErrorBoundary";

const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite"));
const Shell = lazy(() => import("./pages/Shell"));
const Profile = lazy(() => import("./pages/Profile"));
const Placeholder = lazy(() => import("./pages/Placeholder"));
const ImpersonatePage = lazy(() => import("./features/impersonation/ImpersonatePage"));
const NotFound = lazy(() => import("./pages/NotFound"));
const OnboardingPage = lazy(() => import("./features/onboarding/OnboardingPage"));

function RequireAuth() {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <FullPageSpinner label="Restoring your session" />;
  if (status === "anonymous") return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}

export function PublicOnly() {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <FullPageSpinner label="Restoring your session" />;
  // Registering signs the user in before Register.tsx navigates, so this guard sees "authenticated" first:
  // new workspaces go to the setup wizard (it sends finished or non-admin users on to /overview itself).
  if (status === "authenticated") return <Navigate to={loc.pathname === "/register" ? "/onboarding" : "/overview"} replace />;
  return <Outlet />;
}

export function App() {
  return (
    <ErrorBoundary fullPage>
    <Suspense fallback={<FullPageSpinner label="Loading" />}>
      <Routes>
        <Route element={<PublicOnly />}>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
        </Route>
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route element={<RequireAuth />}>
          <Route path="onboarding" element={<OnboardingPage />} />
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/overview" replace />} />
            {featureRoutes}
            <Route path="profile" element={<Profile />} />
          </Route>
        </Route>
        <Route path="impersonate" element={<ImpersonatePage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
