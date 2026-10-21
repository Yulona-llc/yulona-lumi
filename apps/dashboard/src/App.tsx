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
const AdminRoutes = lazy(() => import("./features/admin/AdminRoutes"));
const NotFound = lazy(() => import("./pages/NotFound"));

function RequireAuth() {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <FullPageSpinner label="Restoring your session" />;
  if (status === "anonymous") return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}

function PublicOnly() {
  const { status } = useAuth();
  if (status === "loading") return <FullPageSpinner label="Restoring your session" />;
  if (status === "authenticated") return <Navigate to="/overview" replace />;
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
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/overview" replace />} />
            {featureRoutes}
            <Route path="profile" element={<Profile />} />
          </Route>
        </Route>
        <Route path="admin/*" element={<AdminRoutes />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
