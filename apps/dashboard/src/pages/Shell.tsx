import { Suspense, useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  BellRing, BookOpen, CalendarDays, ChevronsLeft, ChevronsRight, CreditCard, Contact, Gauge, Inbox, KeyRound, LayoutDashboard, LogOut, MonitorSmartphone, Moon, MoreHorizontal,
  PanelsTopLeft, Plug, Cable, Radio, Search, Settings, ShieldAlert, Sun, SunMoon, Ticket, UserCog, Users, Webhook, Bot, type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { Logo, LogoMark } from "../components/Logo";
import { ErrorBoundary, PageSkeleton } from "../components/ErrorBoundary";
import { PageTransition, motion } from "../components/motion";
import { useTheme } from "../components/theme";
import { Toaster } from "@/components/ui/sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import NotificationsBell from "../features/ops-settings/NotificationsBell";
import { AskLumi } from "../features/copilot/CopilotDrawer";
import { ImpersonationBanner } from "../features/impersonation/ImpersonationBanner";
import { CreditsBanner } from "../features/usage/CreditAlerts";
import { useRole } from "../features/common/ui";
import type { Role } from "../features/common/api";
import { cn } from "@/lib/utils";

interface Item { to: string; label: string; icon: LucideIcon; min: Role; keywords?: string }
interface Group { label: string; items: Item[] }

/** Role-aware navigation: an item shows when the user's role is at least `min`. */
const GROUPS: Group[] = [
  { label: "Conversations", items: [
    { to: "/overview", label: "Overview", icon: LayoutDashboard, min: "viewer", keywords: "home dashboard funnel summary" },
    { to: "/inbox", label: "Inbox", icon: Inbox, min: "viewer", keywords: "messages chats conversations" },
    { to: "/attention", label: "Needs attention", icon: ShieldAlert, min: "agent", keywords: "handoff queue escalations" },
    { to: "/contacts", label: "Contacts", icon: Contact, min: "viewer", keywords: "customers leads people" },
  ] },
  { label: "Operations", items: [
    { to: "/tickets", label: "Tickets", icon: Ticket, min: "viewer", keywords: "support issues sla" },
    { to: "/bookings", label: "Bookings", icon: CalendarDays, min: "viewer", keywords: "appointments calendar" },
  ] },
  { label: "AI", items: [
    { to: "/agents", label: "Agents", icon: Bot, min: "admin", keywords: "ai persona assistant" },
    { to: "/knowledge", label: "Knowledge", icon: BookOpen, min: "agent", keywords: "skills documents sources" },
    { to: "/channels", label: "Channels", icon: Radio, min: "admin", keywords: "whatsapp telegram messenger instagram slack" },
  ] },
];
const SETTINGS: Item[] = [
  { to: "/settings/widget", label: "Website widget", icon: PanelsTopLeft, min: "viewer", keywords: "embed chat" },
  { to: "/settings/team", label: "Team", icon: Users, min: "viewer", keywords: "members invitations roles" },
  { to: "/settings/api-keys", label: "API keys", icon: KeyRound, min: "viewer" },
  { to: "/settings/webhooks", label: "Webhooks", icon: Webhook, min: "viewer" },
  { to: "/settings/billing", label: "Billing", icon: CreditCard, min: "viewer", keywords: "plan invoice usage" },
  { to: "/settings/usage", label: "Usage", icon: Gauge, min: "viewer", keywords: "ai credits tokens buy top up" },
  { to: "/settings/integrations", label: "Connectors", icon: Plug, min: "viewer", keywords: "calendar google calendly hubspot crm integrations connect" },
  { to: "/settings/connections", label: "Connections", icon: Cable, min: "viewer", keywords: "tools systems api secret" },
  { to: "/settings/operations", label: "Business hours", icon: BellRing, min: "viewer", keywords: "operations availability" },
  { to: "/settings/account", label: "Account", icon: UserCog, min: "viewer", keywords: "password profile" },
];
const SETTINGS_HOME: Item = { to: "/settings", label: "Settings", icon: Settings, min: "viewer" };
const MOBILE_PRIMARY = ["/overview", "/inbox", "/attention", "/contacts", "/tickets", "/bookings"];

const COLLAPSE_KEY = "yulona-nav-collapsed";
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } };

export default function Shell() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const { theme, setTheme } = useTheme();
  const { atLeast, isOwner } = useRole();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [more, setMore] = useState(false);
  const [palette, setPalette] = useState(false);

  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => atLeast(i.min)) })).filter((g) => g.items.length), [atLeast]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const settingsItems = useMemo(() => SETTINGS.filter((i) => atLeast(i.min)), [atLeast]);
  const bottom = useMemo(() => MOBILE_PRIMARY.map((to) => flat.find((i) => i.to === to)).filter((i): i is Item => !!i).slice(0, 4), [flat]);
  const initials = (session?.user.name ?? "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const section = "/" + (loc.pathname.split("/")[1] ?? "");
  const fullBleed = section === "/inbox";

  useEffect(() => { setMore(false); }, [loc.pathname]);
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ } }, [collapsed]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((o) => !o); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const go = (to: string) => { setPalette(false); setMore(false); navigate(to); };
  const signOut = async () => { await logout(); navigate("/login", { replace: true }); };

  const userMenu = (
    <DropdownMenuContent align="end" className="w-60">
      <DropdownMenuLabel className="space-y-0.5">
        <span className="block truncate text-sm font-semibold text-foreground">{session?.user.name}</span>
        <span className="block truncate font-normal">{session?.user.email}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => go("/profile")}><UserCog />Profile</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => go("/settings")}><Settings />Settings</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
        <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="system"><MonitorSmartphone />System</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={() => void signOut()}><LogOut />Sign out</DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full flex-col bg-background">
        <ImpersonationBanner />
        <CreditsBanner />
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:shadow-lg">Skip to content</a>
        <div className="flex min-h-0 flex-1">
          {/* ---- desktop rail ---- */}
          <aside
            className={cn("relative hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out md:flex", collapsed ? "w-[76px]" : "w-[17rem]")}
            aria-label="Sidebar"
          >
            <div className={cn("flex h-16 items-center", collapsed ? "justify-center" : "justify-between pl-5 pr-3")}>
              {collapsed ? <LogoMark className="size-9" /> : <Logo light className="h-9" />}
            </div>
            {!collapsed && (
              <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-sidebar-accent/60 px-3 py-2 text-sm">
                <span className="relative flex size-2"><span className="absolute inline-flex size-2 animate-pulse-ring rounded-full" /><span className="relative inline-flex size-2 rounded-full bg-[#25d366]" /></span>
                <span className="min-w-0 truncate text-sidebar-foreground">{session?.tenant.name}</span>
              </div>
            )}
            <nav aria-label="Main" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
              {groups.map((g) => (
                <div key={g.label}>
                  {!collapsed && <p className="mb-1.5 px-3 text-xs font-medium text-sidebar-muted">{g.label}</p>}
                  <ul className="space-y-0.5">{g.items.map((i) => <li key={i.to}><RailLink item={i} collapsed={collapsed} /></li>)}</ul>
                </div>
              ))}
            </nav>
            <div className="space-y-0.5 border-t border-sidebar-border px-3 py-3">
              <RailLink item={SETTINGS_HOME} collapsed={collapsed} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className={cn("mt-1 flex w-full items-center gap-3 rounded-lg p-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-primary", collapsed && "justify-center")}>
                    <Avatar className="size-8"><AvatarFallback className="bg-primary text-primary-foreground">{initials}</AvatarFallback></Avatar>
                    {!collapsed && <span className="min-w-0"><span className="block truncate text-sm font-medium">{session?.user.name}</span><span className="block truncate text-xs text-sidebar-muted">{session?.user.email}</span></span>}
                  </button>
                </DropdownMenuTrigger>
                {userMenu}
              </DropdownMenu>
            </div>
            <button
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="absolute -right-3 top-[4.5rem] z-10 grid size-6 place-items-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-muted shadow-md transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-primary"
            >
              {collapsed ? <ChevronsRight className="size-3.5" /> : <ChevronsLeft className="size-3.5" />}
            </button>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* ---- top bar ---- */}
            <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md sm:px-5 md:h-16">
              <LogoMark className="size-8 md:hidden" />
              <button
                onClick={() => setPalette(true)}
                className="group ml-1 flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl border bg-card px-3 text-left text-sm text-muted-foreground shadow-xs outline-none transition-colors hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/30 md:max-w-md md:flex-none md:basis-96"
                aria-label="Search pages and actions"
              >
                <Search className="size-4 shrink-0" />
                <span className="truncate">Search or jump to…</span>
                <kbd className="ml-auto hidden rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px] sm:inline">⌘K</kbd>
              </button>
              <div className="ml-auto flex items-center gap-1">
                <AskLumi />
                <NotificationsBell />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Theme"><ThemeIcon /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
                      <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="system"><SunMoon />System</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="ml-1 rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 md:hidden" aria-label="Account menu">
                      <Avatar className="size-9"><AvatarFallback>{initials}</AvatarFallback></Avatar>
                    </button>
                  </DropdownMenuTrigger>
                  {userMenu}
                </DropdownMenu>
              </div>
            </header>

            <main id="main" tabIndex={-1} className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto outline-none", fullBleed ? "p-0 pb-[calc(3.9rem+env(safe-area-inset-bottom))] md:p-5 md:pb-5 lg:p-6" : "px-4 pb-24 pt-5 sm:px-6 sm:pt-6 md:pb-10 lg:px-8")}>
              <div className={cn("mx-auto h-full w-full", fullBleed ? "[&>div]:h-full" : "max-w-[88rem]")}>
                <ErrorBoundary resetKey={loc.pathname}><Suspense fallback={<PageSkeleton />}><PageTransition id={section}><Outlet /></PageTransition></Suspense></ErrorBoundary>
              </div>
            </main>
          </div>
        </div>

        {/* ---- mobile tab bar ---- */}
        <nav aria-label="Primary" className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-card/92 backdrop-blur-lg md:hidden">
          <ul className="mx-auto flex max-w-lg items-stretch justify-around px-1 pt-1.5">
            {bottom.map((i) => <li key={i.to} className="flex-1"><TabLink item={i} /></li>)}
            <li className="flex-1">
              <button onClick={() => setMore(true)} className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-haspopup="dialog">
                <MoreHorizontal className="size-5" />More
              </button>
            </li>
          </ul>
        </nav>

        <Sheet open={more} onOpenChange={setMore}>
          <SheetContent side="bottom" className="gap-0">
            <SheetHeader><SheetTitle>Menu</SheetTitle><SheetDescription className="sr-only">All sections</SheetDescription></SheetHeader>
            <div className="space-y-5 overflow-y-auto px-4 pb-4">
              {[...groups, { label: "Workspace", items: [SETTINGS_HOME] }].map((g) => (
                <section key={g.label}>
                  <h3 className="mb-2 font-sans text-xs font-medium tracking-normal text-muted-foreground">{g.label}</h3>
                  <ul className="grid grid-cols-3 gap-2">
                    {g.items.map((i) => (
                      <li key={i.to}>
                        <NavLink to={i.to} className={({ isActive }) => cn("flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-xl border px-1 text-center text-xs font-medium transition-colors", isActive ? "border-primary/60 bg-accent text-accent-foreground" : "bg-card hover:bg-muted")}>
                          <i.icon className="size-5" />{i.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <Button variant="outline" className="w-full" onClick={() => void signOut()}><LogOut />Sign out</Button>
            </div>
          </SheetContent>
        </Sheet>

        <CommandDialog open={palette} onOpenChange={setPalette}>
          <CommandInput placeholder="Search pages and actions…" />
          <CommandList>
            <CommandEmpty>Nothing matches. Try “inbox”, “billing” or “team”.</CommandEmpty>
            <CommandGroup heading="Go to">
              {flat.map((i) => (
                <CommandItem key={i.to} value={`${i.label} ${i.keywords ?? ""}`} onSelect={() => go(i.to)}><i.icon />{i.label}</CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Settings">
              {settingsItems.map((i) => <CommandItem key={i.to} value={`${i.label} settings ${i.keywords ?? ""}`} onSelect={() => go(i.to)}><i.icon />{i.label}</CommandItem>)}
            </CommandGroup>
            <CommandGroup heading="Actions">
              <CommandItem value="toggle theme dark light" onSelect={() => { setTheme(theme === "dark" ? "light" : "dark"); setPalette(false); }}><SunMoon />Switch theme<CommandShortcut>Light / dark</CommandShortcut></CommandItem>
              <CommandItem value="sign out log out" onSelect={() => void signOut()}><LogOut />Sign out</CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandDialog>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}

function ThemeIcon() {
  const { resolved } = useTheme();
  return resolved === "dark" ? <Moon /> : <Sun />;
}

/** Sidebar link. The ember bar glides between items (shared layout animation): the shell's one signature motion. */
function RailLink({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.to}
      className={({ isActive }) => cn("group relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-[0.9375rem] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary", collapsed && "justify-center px-0", isActive ? "font-semibold text-white" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-white")}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span layoutId="rail-active" transition={{ type: "spring", stiffness: 420, damping: 36 }} className="absolute inset-0 rounded-lg bg-sidebar-accent">
              <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
            </motion.span>
          )}
          <item.icon className={cn("relative size-5 shrink-0 transition-colors", isActive ? "text-primary" : "text-sidebar-muted group-hover:text-sidebar-foreground")} />
          {!collapsed && <span className="relative truncate">{item.label}</span>}
          {collapsed && <span className="sr-only">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
  return collapsed ? <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right">{item.label}</TooltipContent></Tooltip> : link;
}

function TabLink({ item }: { item: Item }) {
  return (
    <NavLink to={item.to} className={({ isActive }) => cn("relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50", isActive ? "text-foreground" : "text-muted-foreground")}>
      {({ isActive }) => (
        <>
          {isActive && <motion.span layoutId="tab-active" transition={{ type: "spring", stiffness: 420, damping: 36 }} className="absolute inset-x-3 top-0 h-[3px] rounded-b-full bg-primary" />}
          <item.icon className={cn("size-5", isActive && "text-primary")} />
          {item.label === "Needs attention" ? "Attention" : item.label}
        </>
      )}
    </NavLink>
  );
}
