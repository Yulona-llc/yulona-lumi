import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, GitMerge, MessageSquarePlus, Trash2 } from "lucide-react";
import type { ContactDto } from "@yulona/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { ApiError } from "../../api/client";
import { Modal, TextField } from "../common/ui";
import { ATTR_KEY, contactsApi, type ContactPatch } from "./api";
import { CHANNEL_LABEL, contactLabel, fullTime } from "../inbox/format";
import { ChannelGlyph, ContactAvatar } from "../inbox/parts";

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.");

export default function ContactProfile() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["contact", id], queryFn: () => contactsApi.get(id) });
  const [merging, setMerging] = useState(false);
  if (q.isPending) return <div role="status" className="space-y-4"><span className="sr-only">Loading contact…</span><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (q.isError) {
    return (
      <div role="alert" className="mx-auto max-w-sm py-16 text-center">
        <p className="font-display text-lg font-semibold">{q.error instanceof ApiError && q.error.status === 404 ? "Contact not found" : "Could not load contact"}</p>
        <div className="mt-4 flex justify-center gap-2"><Button onClick={() => void q.refetch()}>Retry</Button><Button asChild variant="outline"><Link to="/contacts">Back to contacts</Link></Button></div>
      </div>
    );
  }
  const c = q.data;
  const channels = [...new Set(c.identities.map((i) => i.channel))];
  const attrCount = Object.keys(c.customAttributes).length;
  return (
    <div className="mx-auto max-w-4xl">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3"><Link to="/contacts"><ArrowLeft />All contacts</Link></Button>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <ContactAvatar contact={c} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-2xl font-semibold tracking-tight">{contactLabel(c)}</h1>
          <p className="text-sm text-muted-foreground">First seen {fullTime(c.firstSeenAt)}, {c.identities.length} channel identit{c.identities.length === 1 ? "y" : "ies"}</p>
          {channels.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{channels.map((ch) => <Badge key={ch} variant="outline"><ChannelGlyph channel={ch} />{CHANNEL_LABEL[ch] ?? ch}</Badge>)}</div>}
        </div>
        <Button variant="outline" onClick={() => setMerging(true)}><GitMerge />Merge duplicate</Button>
      </div>

      <Tabs defaultValue="details" className="mt-6">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="attributes">Attributes{attrCount > 0 && <span className="rounded-full bg-card px-1.5 text-xs tabular-nums">{attrCount}</span>}</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="details"><Details c={c} /></TabsContent>
        <TabsContent value="attributes"><Attributes c={c} /></TabsContent>
        <TabsContent value="timeline"><Timeline id={id} /></TabsContent>
      </Tabs>
      {merging && <Merge c={c} onClose={() => setMerging(false)} />}
    </div>
  );
}

function usePatch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ContactPatch) => contactsApi.patch(id, b),
    onSuccess: (c) => { qc.setQueryData(["contact", id], c); void qc.invalidateQueries({ queryKey: ["contacts"] }); },
  });
}

function Details({ c }: { c: ContactDto }) {
  const [v, setV] = useState({ name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "" });
  const m = usePatch(c.id);
  const dirty = v.name !== (c.name ?? "") || v.email !== (c.email ?? "") || v.phone !== (c.phone ?? "");
  return (
    <form className="max-w-lg space-y-4 rounded-2xl border bg-card p-4 sm:p-5" aria-label="Contact details"
      onSubmit={(e) => { e.preventDefault(); m.mutate({ name: v.name.trim() || null, email: v.email.trim() || null, phone: v.phone.trim() || null }, { onSuccess: () => toast.success("Contact saved") }); }}>
      {m.error && <Alert variant="destructive">{msg(m.error)}</Alert>}
      <TextField label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      <TextField label="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
      <TextField label="Phone" type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
      <Button disabled={!dirty || m.isPending}>{m.isPending ? "Saving…" : "Save changes"}</Button>
    </form>
  );
}

function Attributes({ c }: { c: ContactDto }) {
  const [k, setK] = useState("");
  const [val, setVal] = useState("");
  const m = usePatch(c.id);
  const keyErr = k && !ATTR_KEY.test(k) ? "Start with a letter; letters, digits and _ only (max 40)." : undefined;
  const entries = Object.entries(c.customAttributes);
  return (
    <section className="grid max-w-3xl gap-4 md:grid-cols-[1fr_18rem]" aria-label="Custom attributes">
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <h2 className="font-display text-base font-semibold">Custom attributes</h2>
        {m.error && <div className="mt-2"><Alert variant="destructive">{msg(m.error)}</Alert></div>}
        {entries.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No attributes yet. Add one to store things like plan or company.</p> : (
          <ul className="mt-2 divide-y">
            {entries.map(([key, value]) => (
              <li key={key} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 break-words"><span className="text-muted-foreground">{key}</span>: {String(value)}</span>
                <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" disabled={m.isPending} aria-label={`Remove ${key}`} onClick={() => m.mutate({ customAttributes: { [key]: null } })}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5" onSubmit={(e) => { e.preventDefault(); if (!k || keyErr) return; m.mutate({ customAttributes: { [k]: val } }, { onSuccess: () => { setK(""); setVal(""); } }); }}>
        <TextField label="Attribute name" value={k} error={keyErr} onChange={(e) => setK(e.target.value)} />
        <TextField label="Value" value={val} maxLength={500} onChange={(e) => setVal(e.target.value)} />
        <Button variant="outline" className="w-full" disabled={!k || !!keyErr || m.isPending}>Add attribute</Button>
      </form>
    </section>
  );
}

function Merge({ c, onClose }: { c: ContactDto; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [src, setSrc] = useState<ContactDto | null>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  const search = useQuery({ queryKey: ["contacts", "merge", term], queryFn: () => contactsApi.list(term, undefined), enabled: term.trim().length >= 2 });
  const m = useMutation({
    mutationFn: () => contactsApi.merge(c.id, src!.id),
    onSuccess: () => { void qc.invalidateQueries(); toast.success("Contacts merged"); onClose(); nav(`/contacts/${c.id}`); },
  });
  return (
    <Modal title="Merge duplicate" description={`Pick the duplicate to fold into ${contactLabel(c)}.`} onClose={onClose}>
      <div className="space-y-3">
        <TextField label="Find the duplicate" value={term} onChange={(e) => { setTerm(e.target.value); setSrc(null); }} hint="Type at least 2 characters." />
        {search.isFetching && <p role="status" className="text-sm text-muted-foreground">Searching…</p>}
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {search.data?.items.filter((x) => x.id !== c.id).map((x) => (
            <li key={x.id}>
              <button className={cn("flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", src?.id === x.id ? "border-primary bg-accent" : "hover:bg-muted")} aria-pressed={src?.id === x.id} onClick={() => setSrc(x)}>
                <ContactAvatar contact={x} size="sm" /><span className="min-w-0"><b className="block truncate">{contactLabel(x)}</b><span className="block truncate text-muted-foreground">{x.email ?? x.phone ?? ""}</span></span>
              </button>
            </li>
          ))}
        </ul>
        {src && (
          <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
            <p>Move all conversations and identities of <b>{contactLabel(src)}</b> into <b>{contactLabel(c)}</b>? {contactLabel(src)} will be hidden afterwards. This cannot be undone.</p>
            {m.error && <p className="mt-2 text-destructive">{msg(m.error)}</p>}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!src || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Merging…" : "Confirm merge"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Timeline({ id }: { id: string }) {
  const t = useInfiniteQuery({
    queryKey: ["timeline", id],
    queryFn: ({ pageParam }) => contactsApi.timeline(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = t.data?.pages.flatMap((p) => p.items) ?? [];
  const who = (s?: string) => (s === "contact" ? "Customer" : s === "ai" ? "AI assistant" : s === "human" ? "Teammate" : s === "note" ? "Internal note" : "System");
  return (
    <section aria-label="Timeline" className="min-w-0 max-w-2xl">
      {t.isPending && <div role="status" className="space-y-3"><span className="sr-only">Loading timeline…</span><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
      {t.isError && <p role="alert" className="text-destructive">Could not load timeline. <button className="font-semibold underline" onClick={() => void t.refetch()}>Retry</button></p>}
      {t.isSuccess && items.length === 0 && (
        <div className="rounded-2xl border border-dashed bg-card/60 p-8 text-center text-sm text-muted-foreground">
          <MessageSquarePlus className="mx-auto mb-2 size-6" aria-hidden="true" />No activity yet. Conversations with this contact will show up here.
        </div>
      )}
      <ol className="space-y-4 border-l-2 pl-5">
        {items.map((i, n) => (
          <li key={`${i.conversationId}-${i.message?.id ?? i.at}-${n}`} className="relative">
            <span className={cn("absolute -left-[1.72rem] top-1 size-3 rounded-full border-2 border-background", i.type === "conversation_started" ? "bg-primary" : "bg-muted-foreground/50")} aria-hidden="true" />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><time dateTime={i.at}>{fullTime(i.at)}</time><ChannelGlyph channel={i.channel} className="size-3" />{CHANNEL_LABEL[i.channel] ?? i.channel}</p>
            {i.type === "conversation_started"
              ? <p className="mt-0.5 text-sm font-medium">Conversation started <Link className="ml-1 text-accent-foreground underline underline-offset-2" to={`/inbox/${i.conversationId}`}>Open</Link></p>
              : <p className="mt-0.5 text-sm"><b>{who(i.message?.senderType)}</b>: <span className="break-words">{i.message?.content}</span></p>}
          </li>
        ))}
      </ol>
      {t.hasNextPage && <Button variant="outline" className="mt-4" disabled={t.isFetchingNextPage} onClick={() => void t.fetchNextPage()}>Load more</Button>}
    </section>
  );
}
