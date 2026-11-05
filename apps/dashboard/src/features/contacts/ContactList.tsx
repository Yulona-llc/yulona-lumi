import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { AlertTriangle, Plus, Search, SearchX, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { motion } from "@/components/motion";
import { Empty, PageHeader } from "../common/ui";
import { contactsApi } from "./api";
import { CHANNEL_LABEL, contactLabel, timeAgo } from "../inbox/format";
import { ChannelGlyph, ContactAvatar, useMediaQuery } from "../inbox/parts";
import NewContact from "./NewContact";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

const channelsOf = (c: { identities: Array<{ channel: string }> }) => [...new Set(c.identities.map((i) => i.channel))];

export function ChannelChips({ channels }: { channels: string[] }) {
  if (!channels.length) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="flex items-center gap-1.5">
      {channels.map((ch) => <span key={ch} title={CHANNEL_LABEL[ch] ?? ch} className="grid size-6 place-items-center rounded-full bg-muted text-muted-foreground"><ChannelGlyph channel={ch} labelled /></span>)}
    </span>
  );
}

export default function ContactList() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [anon, setAnon] = useState(false); // visitors who never shared a name, email or phone
  const wide = useMediaQuery("(min-width: 768px)");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim() || undefined), 300); return () => clearTimeout(t); }, [q]);
  const list = useInfiniteQuery({
    queryKey: ["contacts", term, anon],
    queryFn: ({ pageParam }) => contactsApi.list(term, pageParam, anon),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  return (
    <section aria-labelledby="h">
      <PageHeader title="Contacts" subtitle="Everyone who has chatted with you, merged across channels."
        actions={<Button onClick={() => setAdding(true)}><Plus />New contact</Button>} />
      <h2 id="h" className="sr-only">Contact list</h2>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="cs" className="sr-only">Search contacts</label>
        <Input id="cs" type="search" className="pl-9" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mt-3 flex items-center gap-2"><Switch id="anon" checked={anon} onCheckedChange={setAnon} /><Label htmlFor="anon" className="text-sm font-normal text-muted-foreground">Show anonymous visitors (no name, email or phone)</Label></div>
      {adding && <NewContact onClose={() => setAdding(false)} />}

      <div className="mt-4" aria-busy={list.isFetching}>
        {list.isPending && (
          <div role="status" className="space-y-2"><span className="sr-only">Loading contacts…</span>
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 w-full" style={{ opacity: 1 - i * 0.14 }} />)}
          </div>
        )}
        {list.isError && (
          <div role="alert" className="flex gap-3 rounded-xl border border-destructive/35 bg-destructive/8 p-4 text-sm">
            <AlertTriangle className="size-5 shrink-0 text-destructive" /><p>Could not load contacts. <button className="font-semibold underline" onClick={() => void list.refetch()}>Retry</button></p>
          </div>
        )}
        {list.isSuccess && items.length === 0 && (
          term
            ? <Empty icon={<SearchX className="size-6" />} title="No matching contacts" body="Try a different name, email or phone number." action={<Button variant="outline" onClick={() => setQ("")}>Clear search</Button>} />
            : <Empty icon={<Users className="size-6" />} title="No contacts yet" body="Contacts are created automatically when visitors start chatting. You can also add one yourself." action={<Button onClick={() => setAdding(true)}><Plus />New contact</Button>} />
        )}

        {items.length > 0 && wide && (
          <div className="overflow-hidden rounded-2xl border bg-card">
            <Table>
              <caption className="sr-only">Contacts</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Name</TableHead><TableHead scope="col">Email</TableHead><TableHead scope="col">Phone</TableHead>
                  <TableHead scope="col">Channels</TableHead><TableHead scope="col" className="text-right">Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => nav(`/contacts/${c.id}`)}>
                    <TableCell>
                      <span className="flex items-center gap-3">
                        <ContactAvatar contact={c} size="sm" />
                        <Link className="font-medium hover:underline" to={`/contacts/${c.id}`} onClick={(e) => e.stopPropagation()}>{contactLabel(c)}</Link>
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.email ?? "-"}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{c.phone ?? "-"}</TableCell>
                    <TableCell><ChannelChips channels={channelsOf(c)} /></TableCell>
                    <TableCell className="text-right text-muted-foreground"><time dateTime={c.lastSeenAt}>{timeAgo(c.lastSeenAt)}</time></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {items.length > 0 && !wide && (
          <ul className="space-y-2" aria-label="Contacts">
            {items.map((c) => (
              <motion.li key={c.id} layout="position">
                <Link to={`/contacts/${c.id}`} className="flex items-center gap-3 rounded-2xl border bg-card p-3 outline-none transition-colors active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/35">
                  <ContactAvatar contact={c} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium">{contactLabel(c)}</span>
                      <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={c.lastSeenAt}>{timeAgo(c.lastSeenAt)}</time>
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">{c.email ?? c.phone ?? "No contact details"}</span>
                    <span className="mt-1.5 block"><ChannelChips channels={channelsOf(c)} /></span>
                  </span>
                </Link>
              </motion.li>
            ))}
          </ul>
        )}
        {list.hasNextPage && <div className="mt-4 text-center"><Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>}
      </div>
    </section>
  );
}
