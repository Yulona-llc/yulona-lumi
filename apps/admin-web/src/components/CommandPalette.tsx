import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Building2, Download, LogOut, Moon, User, UserPlus } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useAuth } from "@/auth/AuthProvider";
import { useTheme } from "@/components/theme";
import { NAV } from "@/nav";
import { StatusBadge } from "@/components/bits";

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Cmd/Ctrl+K. Customers and users come from GET /search (needs 2+ characters); pages and actions are filtered locally. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 200);
  const nav = useNavigate();
  const { can, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const search = useQuery({ queryKey: keys.search(dq), queryFn: () => adminApi.search(dq), enabled: open && dq.length >= 2, staleTime: 15_000 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onOpenChange(!open); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  useEffect(() => { if (!open) setQ(""); }, [open]);

  const go = (to: string) => { onOpenChange(false); nav(to); };
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  const actions = useMemo(() => [
    { id: "export", label: "Export customers as CSV", icon: Download, run: () => go("/customers?export=1") },
    ...(can("manageAdmins") ? [{ id: "invite", label: "Invite an admin", icon: UserPlus, run: () => go("/admins?invite=1") }] : []),
    { id: "theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", icon: Moon, run: () => { setTheme(theme === "dark" ? "light" : "dark"); onOpenChange(false); } },
    { id: "out", label: "Sign out", icon: LogOut, run: () => { onOpenChange(false); void logout(); } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [can, theme]);
  const tenants = search.data?.tenants ?? [];
  const users = search.data?.users ?? [];
  const pages = NAV.filter((n) => match(n.label));
  const acts = actions.filter((a) => match(a.label));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false} title="Search" description="Find customers, users, pages and actions">
      <CommandInput value={q} onValueChange={setQ} placeholder="Search customers, users, pages and actions" aria-label="Search" />
      <CommandList>
        {dq.length >= 2 && search.isFetching && <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Searching</p>}
        {tenants.length > 0 && (
          <CommandGroup heading="Customers">
            {tenants.map((t) => (
              <CommandItem key={t.id} value={`t-${t.id}`} onSelect={() => go(`/customers/${t.id}`)}>
                <Building2 aria-hidden /><span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.matchedOn === "member_email" ? "email match" : t.matchedOn === "id" ? "ID match" : t.plan}</span><StatusBadge status={t.status} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {users.length > 0 && (
          <CommandGroup heading="Users">
            {users.map((u) => (
              <CommandItem key={u.id} value={`u-${u.id}`} onSelect={() => go(`/customers/${u.tenantId}`)}>
                <User aria-hidden /><span className="min-w-0 flex-1 truncate">{u.email}<span className="text-muted-foreground"> in {u.tenantName}</span></span>
                <span className="text-xs text-muted-foreground">{u.role}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {pages.length > 0 && (
          <CommandGroup heading="Pages">
            {pages.map((n) => <CommandItem key={n.to} value={`p-${n.to}`} onSelect={() => go(n.to)}><n.icon aria-hidden />{n.label}</CommandItem>)}
          </CommandGroup>
        )}
        {acts.length > 0 && (
          <CommandGroup heading="Actions">
            {acts.map((a) => <CommandItem key={a.id} value={`a-${a.id}`} onSelect={a.run}><a.icon aria-hidden />{a.label}</CommandItem>)}
          </CommandGroup>
        )}
        {dq.length >= 2 && !search.isFetching && tenants.length + users.length + pages.length + acts.length === 0 && <CommandEmpty>No results for “{dq}”.</CommandEmpty>}
        {dq.length < 2 && pages.length + acts.length === 0 && <CommandEmpty>Type at least 2 characters to search customers.</CommandEmpty>}
      </CommandList>
    </CommandDialog>
  );
}
