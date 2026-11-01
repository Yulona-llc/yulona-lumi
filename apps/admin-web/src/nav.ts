import { Activity, AlertTriangle, Building2, Coins, Flag, LayoutDashboard, ScrollText, Users, type LucideIcon } from "lucide-react";

export interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean }
export const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/customers", label: "Customers", icon: Building2 },
  { to: "/attention", label: "Needs attention", icon: AlertTriangle },
  { to: "/operations", label: "Operations", icon: Activity },
  { to: "/billing", label: "Billing and credits", icon: Coins },
  { to: "/flags", label: "Feature flags", icon: Flag },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/admins", label: "Admins", icon: Users },
];
