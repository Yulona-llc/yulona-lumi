export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const fullTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const contactLabel = (c: { name: string | null; email: string | null; phone: string | null }) =>
  c.name || c.email || c.phone || "Anonymous visitor";
export const STATUS_LABEL = { open: "Open", pending_human: "Needs attention", resolved: "Resolved" } as const;
export const initials = (label: string) => {
  const p = label.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p.length > 1 ? p[p.length - 1]![0] : "")).toUpperCase();
};
export const CHANNEL_LABEL: Record<string, string> = {
  widget: "Website chat", whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram", slack: "Slack",
};
export const dayLabel = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};
export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
