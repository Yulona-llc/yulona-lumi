import { Suspense, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronsLeft, ChevronsRight, KeyRound, LogOut, Menu, Moon, MonitorSmartphone, Search, ShieldCheck, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useAuth } from "@/auth/AuthProvider";
import { roleLabel } from "@/auth/permissions";
import { LogoMark } from "@/components/Logo";
import { ErrorBoundary, PageSkeleton } from "@/components/ErrorBoundary";
import { CommandPalette } from "@/components/CommandPalette";
import { useTheme } from "@/components/theme";
import { NAV, type NavItem } from "@/nav";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "lumi-admin-sidebar";
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } };

function NavRow({ item, collapsed, badge, onNavigate }: { item: NavItem; collapsed: boolean; badge?: number; onNavigate?: () => void }) {
  const link = (
    <NavLink
      to={item.to} end={item.end} onClick={onNavigate} aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) => cn("group relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-white" : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white", collapsed && "justify-center px-0")}
    >
      {({ isActive }) => (<>
        {isActive && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-primary" />}
        <item.icon className={cn("size-[1.15rem] shrink-0", isActive && "text-primary")} aria-hidden />
        {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {!collapsed && badge ? <span className="rounded-full bg-primary/20 px-1.5 text-xs font-semibold tabular-nums text-primary" aria-label={`${badge} customers`}>{badge}</span> : null}
        {collapsed && badge ? <span aria-hidden className="absolute right-2 top-2 size-2 rounded-full bg-primary" /> : null}
      </>)}
    </NavLink>
  );
  if (!collapsed) return link;
  return <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right">{item.label}</TooltipContent></Tooltip>;
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn("flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4", collapsed && "justify-center px-0")}>
      <LogoMark className="size-8" />
      {!collapsed && <div className="min-w-0 leading-tight"><p className="font-display text-[0.95rem] font-semibold text-white">Lumi</p><p className="flex items-center gap-1 text-[0.7rem] uppercase tracking-wider text-sidebar-muted"><ShieldCheck className="size-3" aria-hidden />Platform admin</p></div>}
    </div>
  );
}

export default function Shell() {
  const { admin, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const attention = useQuery({ queryKey: keys.attention(1, 0), queryFn: () => adminApi.attention(1, 0), staleTime: 60_000 });
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* private mode */ } }, [collapsed]);
  useEffect(() => setDrawer(false), [loc.pathname]);
  const badgeFor = (i: NavItem) => (i.to === "/attention" ? attention.data?.total : undefined);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const userMenu = (
    <DropdownMenuContent align="end" className="w-60">
      <DropdownMenuLabel className="font-normal"><p className="truncate font-medium">{admin?.name}</p><p className="truncate text-xs text-muted-foreground">{admin?.email}</p></DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => nav("/account")}><KeyRound />Password and two-factor</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
        <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="system"><MonitorSmartphone />System</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={() => void logout()}><LogOut />Sign out</DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full bg-background">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:shadow-lg">Skip to content</a>
        <aside className={cn("relative hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex", collapsed ? "w-[68px]" : "w-60")}>
          <Brand collapsed={collapsed} />
          <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto p-2.5">
            {NAV.map((i) => <NavRow key={i.to} item={i} collapsed={collapsed} badge={badgeFor(i)} />)}
          </nav>
          <div className="border-t border-sidebar-border p-2.5">
            <button type="button" onClick={() => setCollapsed((c) => !c)} aria-pressed={collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn("flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white", collapsed && "justify-center px-0")}>
              {collapsed ? <ChevronsRight className="size-4" aria-hidden /> : <><ChevronsLeft className="size-4" aria-hidden />Collapse</>}
            </button>
          </div>
        </aside>

        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Navigation</SheetTitle><SheetDescription className="sr-only">Platform admin pages</SheetDescription>
            <Brand collapsed={false} />
            <nav aria-label="Main" className="space-y-0.5 p-2.5">{NAV.map((i) => <NavRow key={i.to} item={i} collapsed={false} badge={badgeFor(i)} onNavigate={() => setDrawer(false)} />)}</nav>
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur sm:px-5">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu /></Button>
            <button type="button" onClick={() => setPalette(true)} aria-label="Search customers, users, pages and actions"
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3 text-left text-sm text-muted-foreground transition-colors hover:border-ring/50 sm:max-w-md sm:flex-none sm:basis-96">
              <Search className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate">Search customers, users</span>
              <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 font-mono text-[0.7rem] sm:block">{mac ? "⌘" : "Ctrl"} K</kbd>
            </button>
            <div className="ml-auto flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-muted" aria-label="Account menu">
                    <span className="grid size-8 place-items-center rounded-full bg-primary/15 font-display text-sm font-semibold text-accent-foreground">{(admin?.name ?? "?").slice(0, 1).toUpperCase()}</span>
                    <span className="hidden min-w-0 leading-tight sm:block"><span className="block max-w-40 truncate text-sm font-medium">{admin?.name}</span><span className="block text-xs text-muted-foreground">{admin ? roleLabel[admin.role] : ""}</span></span>
                  </button>
                </DropdownMenuTrigger>
                {userMenu}
              </DropdownMenu>
              <Button variant="ghost" size="sm" className="max-sm:hidden" onClick={() => void logout()}><LogOut aria-hidden />Sign out</Button>
            </div>
          </header>
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[88rem] px-4 py-5 sm:px-6 sm:py-7">
              <ErrorBoundary resetKey={loc.pathname}>
                <Suspense fallback={<PageSkeleton />}><Outlet /></Suspense>
              </ErrorBoundary>
            </div>
          </main>
        </div>
        <CommandPalette open={palette} onOpenChange={setPalette} />
      </div>
    </TooltipProvider>
  );
}
