import { Link, Navigate, NavLink, Outlet, useLocation } from "react-router";
import { Building2, CalendarDays, ChevronLeft, ChevronRight, Cable, Clock, CreditCard, Gauge, KeyRound, MessageSquareText, MessagesSquare, ScrollText, ShieldCheck, Tag, Users, Webhook, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "./parts";

interface Item { to: string; label: string; hint: string; icon: LucideIcon }
interface Group { label: string; items: Item[] }

const GROUPS: Group[] = [
  { label: "Workspace", items: [
    { to: "account", label: "Account", hint: "Name, plan and usage", icon: Building2 },
    { to: "team", label: "Team", hint: "Members, roles and invitations", icon: Users },
    { to: "billing", label: "Billing", hint: "Plan, invoices and payment", icon: CreditCard },
    { to: "usage", label: "Usage", hint: "AI credits, tokens and exports", icon: Gauge },
  ] },
  { label: "Customer chat", items: [
    { to: "widget", label: "Widget", hint: "Branding, domains and embed code", icon: MessageSquareText },
    { to: "operations", label: "Hours and routing", hint: "Business hours and assignment", icon: Clock },
    { to: "canned", label: "Canned responses", hint: "Saved replies for your team", icon: MessagesSquare },
    { to: "tags", label: "Tags", hint: "Labels for conversations", icon: Tag },
    { to: "connections", label: "Connections", hint: "Systems your AI tools talk to", icon: Cable },
    { to: "integrations", label: "Calendar", hint: "Booking calendar connection", icon: CalendarDays },
  ] },
  { label: "Developers and security", items: [
    { to: "api-keys", label: "API keys", hint: "Server-to-server access", icon: KeyRound },
    { to: "webhooks", label: "Webhooks", hint: "Send events to your systems", icon: Webhook },
    { to: "audit", label: "Audit log", hint: "Who changed what", icon: ScrollText },
    { to: "data", label: "Data and privacy", hint: "Retention, export and deletion", icon: ShieldCheck },
  ] },
];
const ALL = GROUPS.flatMap((g) => g.items);

/**
 * Phones and tablets: /settings is a list that drills into a section (with a back link).
 * Desktop: a left sub-nav beside the section.
 */
export default function SettingsLayout() {
  const { pathname } = useLocation();
  const wide = useMediaQuery("(min-width: 1280px)");
  const atRoot = /^\/settings\/?$/.test(pathname);
  const current = ALL.find((i) => pathname.startsWith(`/settings/${i.to}`));

  if (atRoot && wide) return <Navigate to="widget" replace />;

  if (atRoot) {
    return (
      <section aria-labelledby="h" className="max-w-xl">
        <h1 id="h" className="mb-5 font-display text-2xl font-semibold tracking-tight">Settings</h1>
        <div className="space-y-6">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{g.label}</h2>
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
                {g.items.map((i) => (
                  <li key={i.to}>
                    <Link to={i.to} className="flex min-h-16 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"><i.icon className="size-5" /></span>
                      <span className="min-w-0 flex-1"><span className="block font-medium">{i.label}</span><span className="block truncate text-sm text-muted-foreground">{i.hint}</span></span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>))}
              </ul>
            </div>))}
        </div>
      </section>
    );
  }

  return (
    <div className="xl:grid xl:grid-cols-[14.5rem_minmax(0,1fr)] xl:gap-8">
      <nav aria-label="Settings sections" className="hidden xl:block">
        <div className="sticky top-4 space-y-5">
          <h2 className="px-3 font-display text-lg font-semibold">Settings</h2>
          {GROUPS.map((g) => (
            <div key={g.label}>
              <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">{g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} className={({ isActive }) => cn("flex min-h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors", isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                      <i.icon className="size-4" />{i.label}
                    </NavLink>
                  </li>))}
              </ul>
            </div>))}
        </div>
      </nav>
      <div className="min-w-0">
        <Link to="/settings" className="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground xl:hidden"><ChevronLeft className="size-4" />Settings{current ? <span className="text-foreground"> / {current.label}</span> : null}</Link>
        <Outlet />
      </div>
    </div>
  );
}
