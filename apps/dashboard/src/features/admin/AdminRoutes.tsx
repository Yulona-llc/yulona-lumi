import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router";
import { Download, LogOut, ShieldCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "../../components/ui";
import { Logo } from "../../components/Logo";
import { errMsg } from "../common/api";
import { TextField } from "../common/ui";
import { adminApi, getAdminToken, subscribeAdmin } from "./api";

const Overview = lazy(() => import("./OverviewPage"));
const Tenants = lazy(() => import("./TenantsPage"));
const TenantDetail = lazy(() => import("./TenantDetailPage"));
const Flags = lazy(() => import("./FlagsPage"));
const Credits = lazy(() => import("./CreditsAdmin"));

function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-full place-items-center bg-background p-4">
      <Card className="w-full max-w-sm gap-5 p-6 shadow-lg">
        <form className="contents" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(""); try { await adminApi.login(email.trim(), pw); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); } }}>
          <Logo />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Platform admin</h1>
            <p className="mt-1 text-sm text-muted-foreground">Separate sign-in for platform operators. Workspace accounts cannot use it.</p>
          </div>
          {err && <Alert variant="destructive">{err}</Alert>}
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <TextField label="Password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          <Button disabled={busy}>{busy && <Spinner />}Sign in</Button>
          <p className="text-center text-sm"><Link to="/login" className="font-medium underline underline-offset-4">Back to workspace sign-in</Link></p>
        </form>
      </Card>
    </main>
  );
}

const items = [["/admin", "Overview", true], ["/admin/tenants", "Tenants", false], ["/admin/credits", "Credits", false], ["/admin/flags", "Feature flags", false]] as const;

function Layout() {
  const nav = useNavigate();
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="shrink-0 border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <Logo />
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground"><ShieldCheck className="size-3.5" aria-hidden /><span className="whitespace-nowrap">Platform admin</span></span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void adminApi.exportAudit("csv")}><Download aria-hidden /><span className="max-sm:sr-only">Export audit CSV</span></Button>
            <Button variant="ghost" size="sm" onClick={() => { adminApi.logout(); nav("/admin"); }}><LogOut aria-hidden /><span className="max-sm:sr-only">Sign out</span></Button>
          </div>
        </div>
        <nav aria-label="Admin" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 sm:px-5">
          {items.map(([to, l, end]) => <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-medium ${isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{l}</NavLink>)}
        </nav>
      </header>
      <main id="main" className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          <Suspense fallback={<div role="status" className="space-y-3"><span className="sr-only">Loading…</span><Skeleton className="h-10 w-1/3" /><Skeleton className="h-40" /></div>}>
            <Routes><Route index element={<Overview />} /><Route path="tenants" element={<Tenants />} /><Route path="tenants/:id" element={<TenantDetail />} /><Route path="credits/*" element={<Credits />} /><Route path="flags" element={<Flags />} /><Route path="*" element={<Navigate to="/admin" replace />} /></Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
}

/** `/admin/*`: guarded by the platform-admin realm (token in memory), independent of the tenant session. */
export default function AdminRoutes() {
  const tok = useSyncExternalStore(subscribeAdmin, getAdminToken);
  return tok ? <Layout /> : <Login />;
}
