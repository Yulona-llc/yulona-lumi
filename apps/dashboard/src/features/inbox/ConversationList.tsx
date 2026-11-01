import { keys } from "@/api/keys";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { AlertTriangle, Bot, CheckCircle2, Inbox as InboxIcon, Search, SearchX, SlidersHorizontal, User, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { motion } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Empty } from "../common/ui";
import { useConnectionState } from "../realtime/hooks";
import { inboxApi, isUnread, type ConvFilters, type ConversationSummary } from "./api";
import { CHANNEL_LABEL, contactLabel, STATUS_LABEL, timeAgo } from "./format";
import { ChannelGlyph, ContactAvatar, useMediaQuery } from "./parts";

const CHANNELS = Object.keys(CHANNEL_LABEL);
const STATUSES: Array<[string, string]> = [["open", "Open"], ["pending_human", "Needs attention"], ["resolved", "Resolved"]];
const HANDLERS: Array<[string, string]> = [["ai", "AI"], ["human", "Human"]];

/** Who is answering, and whether someone needs to step in. */
export function StatusBadge({ c }: { c: Pick<ConversationSummary, "status" | "handler"> }) {
  if (c.status === "pending_human") return <Badge variant="warning"><AlertTriangle />{STATUS_LABEL.pending_human}</Badge>;
  if (c.status === "resolved") return <Badge variant="secondary"><CheckCircle2 />{STATUS_LABEL.resolved}</Badge>;
  return c.handler === "ai" ? <Badge variant="info"><Bot />AI</Badge> : <Badge variant="default"><User />Human</Badge>;
}

export default function ConversationList({ activeId }: { activeId?: string }) {
  const nav = useNavigate();
  const [filters, setFilters] = useState<ConvFilters>({});
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState(false);
  const wide = useMediaQuery("(min-width: 768px)");
  const search = useRef<HTMLInputElement>(null);
  const conn = useConnectionState();

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === (q || undefined) ? f : { ...f, q: q || undefined })), 300);
    return () => clearTimeout(t);
  }, [q]);

  const users = useQuery({ queryKey: keys.usersInbox, queryFn: inboxApi.users, staleTime: 5 * 60_000, retry: false });
  const list = useInfiniteQuery({
    queryKey: ["conversations", filters],
    queryFn: ({ pageParam }) => inboxApi.list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  // Keyboard: j/k move through the list, "/" focuses search.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); search.current?.focus(); return; }
      if (e.key !== "j" && e.key !== "k") return;
      const i = items.findIndex((c) => c.id === activeId);
      const next = items[e.key === "j" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next) nav(`/inbox/${next.id}`);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [items, activeId, nav]);

  const setF = (k: keyof ConvFilters, v: string | undefined) => setFilters((f) => ({ ...f, [k]: v || undefined }));
  const assigneeName = (v: string) => (v === "me" ? "Assigned to me" : v === "unassigned" ? "Unassigned" : (users.data?.items.find((u) => u.id === v)?.name ?? "Assignee"));
  const chips: Array<{ k: keyof ConvFilters; label: string }> = [];
  if (filters.status) chips.push({ k: "status", label: STATUS_LABEL[filters.status as keyof typeof STATUS_LABEL] ?? filters.status });
  if (filters.handler) chips.push({ k: "handler", label: filters.handler === "ai" ? "AI" : "Human" });
  if (filters.channel) chips.push({ k: "channel", label: CHANNEL_LABEL[filters.channel] ?? filters.channel });
  if (filters.assignee) chips.push({ k: "assignee", label: assigneeName(filters.assignee) });
  const filtered = chips.length > 0 || !!filters.q;
  const clearAll = () => { setQ(""); setFilters({}); };

  return (
    <>
      <div className="space-y-3 border-b p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-xl font-semibold tracking-tight">Inbox</h1>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span className={cn("size-2 rounded-full", conn === "open" ? "bg-success" : "bg-warning")} aria-hidden="true" />
            {conn === "open" ? "Live" : conn === "closed" ? "Offline" : "Reconnecting"}
          </span>
        </div>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <label className="sr-only" htmlFor="inbox-search">Search conversations</label>
            <Input id="inbox-search" ref={search} type="search" className="pl-9 pr-9" placeholder="Search name, email or message" value={q} onChange={(e) => setQ(e.target.value)} />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground lg:block" aria-hidden="true">/</kbd>
          </div>
          <Button variant="outline" size="icon" className="relative" aria-label={chips.length ? `Filters (${chips.length} active)` : "Filters"} onClick={() => setSheet(true)}>
            <SlidersHorizontal />
            {chips.length > 0 && <span className="absolute -right-1 -top-1 grid size-4.5 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground tabular-nums">{chips.length}</span>}
          </Button>
        </div>
        <AnimatePresence initial={false}>
          {chips.length > 0 && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex flex-wrap items-center gap-1.5 overflow-hidden" aria-label="Active filters">
              {chips.map((c) => (
                <button key={c.k} onClick={() => setF(c.k, undefined)} aria-label={`Remove filter: ${c.label}`}
                  className="inline-flex min-h-7 items-center gap-1 rounded-full bg-accent px-2.5 text-xs font-semibold text-accent-foreground outline-none hover:bg-primary/25 focus-visible:ring-[3px] focus-visible:ring-ring/35">
                  {c.label}<X className="size-3" />
                </button>
              ))}
              <button onClick={clearAll} className="px-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:underline">Clear all</button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={list.isFetching}>
        {list.isPending && (
          <div role="status" aria-live="polite" className="divide-y">
            <span className="sr-only">Loading conversations…</span>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex gap-3 px-4 py-3.5" style={{ opacity: 1 - i * 0.1 }}>
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-5 w-24 rounded-full" /></div>
              </div>
            ))}
          </div>
        )}
        {list.isError && (
          <div role="alert" className="m-4 flex gap-3 rounded-xl border border-destructive/35 bg-destructive/8 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p>Could not load conversations. <button className="font-semibold underline" onClick={() => void list.refetch()}>Retry</button></p>
          </div>
        )}
        {list.isSuccess && items.length === 0 && (
          <div className="p-4">
            {filtered ? (
              <Empty icon={<SearchX className="size-6" />} title="No matches" body="Nothing fits these filters. Loosen one, or start over."
                action={<Button variant="outline" onClick={clearAll}>Clear filters</Button>} />
            ) : (
              <Empty icon={<InboxIcon className="size-6" />} title="No conversations yet" body="Conversations from your widget and channels will appear here the moment a customer writes in."
                action={<Button asChild variant="outline"><Link to="/channels">Connect a channel</Link></Button>} />
            )}
          </div>
        )}
        <ul aria-label="Conversations">
          {items.map((c) => {
            const unread = isUnread(c, activeId);
            const active = c.id === activeId;
            return (
              <motion.li key={c.id} layout="position" transition={{ duration: 0.2 }} className="border-b last:border-0">
                <button
                  onClick={() => nav(`/inbox/${c.id}`)}
                  aria-current={active ? "true" : undefined}
                  className={cn("relative flex w-full gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35", active && "bg-accent/70 hover:bg-accent/70")}
                >
                  {active && <motion.span layoutId="inbox-active" className="absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden="true" />}
                  <ContactAvatar contact={c.contact} channel={c.channel} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn("flex min-w-0 items-center gap-2 truncate", unread ? "font-semibold" : "font-medium")}>
                        {unread && <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label="Unread" />}
                        <span className="truncate">{contactLabel(c.contact)}</span>
                      </span>
                      <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={c.lastMessageAt}>{timeAgo(c.lastMessageAt)}</time>
                    </span>
                    <span className={cn("mt-0.5 block truncate text-sm", unread ? "text-foreground" : "text-muted-foreground")}>{c.lastMessagePreview ?? "No messages"}</span>
                    <span className="mt-1.5 flex items-center gap-2"><StatusBadge c={c} />{c.contact.blockedAt && <Badge variant="destructive">Blocked</Badge>}<span className="flex items-center gap-1 text-xs text-muted-foreground"><ChannelGlyph channel={c.channel} className="size-3" />{CHANNEL_LABEL[c.channel] ?? c.channel}</span></span>
                  </span>
                </button>
              </motion.li>
            );
          })}
        </ul>
        {list.hasNextPage && (
          <div className="p-4">
            <Button variant="outline" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>
      <p className="hidden shrink-0 items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground lg:flex" aria-hidden="true">
        <span><kbd className="rounded border bg-muted px-1.5 font-mono">j</kbd> <kbd className="rounded border bg-muted px-1.5 font-mono">k</kbd> move</span>
        <span><kbd className="rounded border bg-muted px-1.5 font-mono">/</kbd> search</span>
      </p>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side={wide ? "right" : "bottom"} className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Filter conversations</SheetTitle>
            <SheetDescription>Narrow the list by who is answering, where it came from, or who owns it.</SheetDescription>
          </SheetHeader>
          <div className="space-y-5 px-4 pb-2">
            <ChipGroup label="Status" value={filters.status} options={STATUSES} onChange={(v) => setF("status", v)} />
            <ChipGroup label="Handled by" value={filters.handler} options={HANDLERS} onChange={(v) => setF("handler", v)} />
            <ChipGroup label="Channel" value={filters.channel} options={CHANNELS.map((c) => [c, CHANNEL_LABEL[c]!] as [string, string])} onChange={(v) => setF("channel", v)} />
            <div className="grid gap-2">
              <span id="f-assignee" className="text-sm font-medium">Assignee</span>
              <Select value={filters.assignee ?? "any"} onValueChange={(v) => setF("assignee", v === "any" ? undefined : v)}>
                <SelectTrigger aria-labelledby="f-assignee"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Anyone</SelectItem>
                  <SelectItem value="me">Me</SelectItem>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {(users.data?.items ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" disabled={!chips.length} onClick={() => setFilters((f) => ({ q: f.q }))}>Reset</Button>
              <Button className="flex-1" onClick={() => setSheet(false)}>Show {items.length}{list.hasNextPage ? "+" : ""} {items.length === 1 ? "conversation" : "conversations"}</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ChipGroup({ label, value, options, onChange }: { label: string; value?: string; options: Array<[string, string]>; onChange: (v: string | undefined) => void }) {
  return (
    <div role="group" aria-label={label} className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(value === v ? undefined : v)}
            className={cn("min-h-10 rounded-full border px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35 sm:min-h-8",
              value === v ? "border-primary bg-primary/15 text-accent-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground")}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
