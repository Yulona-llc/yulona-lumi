import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, ArrowLeftRight, Bot, Hand, Lock, RotateCcw, Sparkles, UserRound, type LucideIcon } from "lucide-react";
import { motion } from "@/components/motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MessageView } from "./api";
import { clockTime, dayLabel, fullTime, initials } from "./format";
import { AiAvatar } from "./parts";

type Tone = "neutral" | "warning" | "primary" | "success" | "danger";
const TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  warning: "border-warning/40 bg-warning/10 text-warning",
  primary: "border-primary/45 bg-accent text-accent-foreground",
  success: "border-success/35 bg-success/10 text-success",
  danger: "border-destructive/40 bg-destructive/8 text-destructive",
};

/** A slim row on the conversation timeline: handoffs, takeovers, returns, delivery problems. */
export function EventRow({ icon: Icon, tone = "neutral", at, children, fresh }: { icon: LucideIcon; tone?: Tone; at?: string; children: ReactNode; fresh?: boolean }) {
  return (
    <motion.li initial={fresh ? { opacity: 0, scale: 0.96 } : false} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 30 }}
      className="flex items-center gap-3 py-0.5 text-xs">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className={cn("inline-flex max-w-[85%] items-center gap-1.5 rounded-full border bg-card px-3 py-1 font-medium", TONE[tone])}>
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{children}</span>
        {at && <time dateTime={at} className="shrink-0 font-normal tabular-nums opacity-70">{clockTime(at)}</time>}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </motion.li>
  );
}

function systemEvent(m: MessageView, fresh: boolean) {
  const ev = (m.metadata as { event?: string } | undefined)?.event;
  if (ev === "takeover") return <EventRow key={m.id} icon={Hand} tone="primary" at={m.createdAt} fresh={fresh}>{m.senderName ? `${m.senderName} took over` : "A teammate took over"}</EventRow>;
  if (ev === "returned_to_ai") return <EventRow key={m.id} icon={Bot} tone="success" at={m.createdAt} fresh={fresh}>Conversation returned to the AI</EventRow>;
  if (ev === "delivery_failed") return <EventRow key={m.id} icon={AlertTriangle} tone="danger" at={m.createdAt} fresh={fresh}>{m.content}</EventRow>;
  return <EventRow key={m.id} icon={Sparkles} at={m.createdAt} fresh={fresh}>{m.content}</EventRow>;
}

const HANDOFF_REASON: Record<string, string> = { uncertainty: "the AI was not confident in an answer" };
function handoffOf(m: MessageView): { type: string; reason?: string } | null {
  const h = (m.metadata as { handoff?: { type?: string; reason?: string } } | undefined)?.handoff;
  return h && typeof h === "object" ? { type: h.type ?? "handoff", reason: h.reason } : null;
}

/** Who spoke: drives alignment, colour and the attribution line. */
function who(m: MessageView) {
  switch (m.senderType) {
    case "contact": return { key: "contact", label: "Customer", side: "left" as const };
    case "ai": return { key: "ai", label: "AI assistant", side: "right" as const };
    case "note": return { key: `note-${m.senderUserId ?? ""}`, label: m.senderName ? `${m.senderName} (internal note)` : "Internal note", side: "right" as const };
    default: return { key: `human-${m.senderUserId ?? ""}`, label: m.senderName ?? "Teammate", side: "right" as const };
  }
}

const BUBBLE: Record<string, string> = {
  contact: "rounded-bl-md border bg-card text-card-foreground",
  ai: "rounded-br-md border border-sidebar-border bg-sidebar text-sidebar-foreground",
  human: "rounded-br-md bg-primary text-primary-foreground",
  note: "rounded-br-md border border-dashed border-warning/60 bg-warning/10 text-foreground",
};

export function Bubble({ m, onRetry, first = true, last = true, fresh }: { m: MessageView; onRetry?: (m: MessageView) => void; first?: boolean; last?: boolean; fresh?: boolean }) {
  if (m.senderType === "system") return systemEvent(m, !!fresh);
  const w = who(m);
  const right = w.side === "right";
  const sig = m.senderType === "contact" ? "contact" : m.senderType;
  return (
    <motion.li
      initial={fresh ? { opacity: 0, y: 14, scale: 0.97 } : false} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 28 }}
      className={cn("flex items-end gap-2", right ? "justify-end" : "justify-start")}
    >
      {!right && <span className="w-7 shrink-0">{last && <Avatar className="size-7"><AvatarFallback className="bg-secondary text-[10px] text-secondary-foreground">C</AvatarFallback></Avatar>}</span>}
      <div className={cn("flex max-w-[84%] flex-col md:max-w-[68%]", right ? "items-end" : "items-start")}>
        {first && (
          <p className="mb-1 flex items-center gap-1 px-1 text-xs text-muted-foreground">
            {m.senderType === "note" && <Lock className="size-3" aria-hidden="true" />}
            <span className="font-medium">{w.label}</span>
            <span aria-hidden="true">at</span>
            <time dateTime={m.createdAt} title={fullTime(m.createdAt)}>{clockTime(m.createdAt)}</time>
          </p>
        )}
        <div className={cn("rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed", BUBBLE[sig], m.pending && "opacity-60", m.failed && "ring-2 ring-destructive")}>
          {/* React escapes text; never use innerHTML for message content. */}
          <p className="whitespace-pre-wrap break-words">{m.content}</p>
          <UiSummary m={m} />
        </div>
        {(m.pending || m.failed) && (
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            {m.pending && "Sending…"}
            {m.failed && <><span className="font-medium text-destructive">Not sent</span> <button className="font-medium underline underline-offset-2" onClick={() => onRetry?.(m)}>Retry</button></>}
          </p>
        )}
      </div>
      {right && <span className="w-7 shrink-0">{last && (m.senderType === "ai" ? <AiAvatar /> : m.senderType === "note"
        ? <span className="grid size-7 place-items-center rounded-full bg-warning/15 text-warning" aria-hidden="true"><Lock className="size-3.5" /></span>
        : <Avatar className="size-7"><AvatarFallback className="bg-primary text-[10px] text-primary-foreground">{initials(m.senderName ?? "T")}</AvatarFallback></Avatar>)}</span>}
    </motion.li>
  );
}

/** Brief, text-only rendition of rich WidgetUI blocks (the plain `content` is the source of truth). */
function UiSummary({ m }: { m: MessageView }) {
  const comps = m.ui?.components.filter((c) => c.type !== "message") ?? [];
  if (!comps.length) return null;
  return (
    <p className="mt-1 text-xs opacity-80">
      {comps.map((c) => (c.type === "buttons" ? `Buttons: ${c.buttons.map((b) => b.label).join(", ")}` : c.type === "form" ? `Form (${c.fields.length} fields)` : c.type === "calendar" ? `Calendar (${c.slots.length} slots)` : c.type === "card" ? `Card: ${c.title}` : "")).join(" · ")}
    </p>
  );
}

function TypingBubble() {
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-end gap-2" role="status">
      <Avatar className="size-7"><AvatarFallback className="bg-secondary text-[10px] text-secondary-foreground">C</AvatarFallback></Avatar>
      <span className="inline-flex items-center gap-1 rounded-2xl rounded-bl-md border bg-card px-3.5 py-3">
        <span className="sr-only">Customer is typing…</span>
        {[0, 1, 2].map((i) => (
          <motion.span key={i} aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground" animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />
        ))}
      </span>
    </motion.li>
  );
}

export default function Thread({ messages, hasOlder, loadingOlder, onLoadOlder, onRetry, typing }: {
  messages: MessageView[]; hasOlder: boolean; loadingOlder: boolean; onLoadOlder: () => void; onRetry: (m: MessageView) => void; typing: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevH = useRef(0);
  const known = useRef<Set<string> | null>(null);
  if (known.current === null) known.current = new Set(messages.map((m) => m.id));
  const isFresh = (id: string) => !known.current!.has(id);
  useEffect(() => { for (const m of messages) known.current!.add(m.id); });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (prevH.current && !stick.current && el.scrollHeight > prevH.current && loadingOlder === false) el.scrollTop += el.scrollHeight - prevH.current;
    if (stick.current) el.scrollTop = el.scrollHeight;
    prevH.current = el.scrollHeight;
  }, [messages, typing, loadingOlder]);
  useEffect(() => { stick.current = true; }, []);

  const rows: ReactNode[] = [];
  let prev: MessageView | null = null;
  let prevWho = "";
  messages.forEach((m, i) => {
    const day = dayLabel(m.createdAt);
    if (!prev || dayLabel(prev.createdAt) !== day) {
      rows.push(<li key={`d-${m.id}`} className="py-1 text-center text-xs font-medium text-muted-foreground"><span>{day}</span></li>);
      prev = null; prevWho = "";
    }
    if (m.senderType === "system") { rows.push(<Fragment key={m.id}>{systemEvent(m, isFresh(m.id))}</Fragment>); prev = m; prevWho = ""; return; }
    const w = who(m).key;
    const next = messages[i + 1];
    const near = prev && prevWho === w && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
    const nextSame = next && next.senderType !== "system" && who(next).key === w && dayLabel(next.createdAt) === day && new Date(next.createdAt).getTime() - new Date(m.createdAt).getTime() < 5 * 60_000 && !handoffOf(m);
    rows.push(<Bubble key={m.id} m={m} onRetry={onRetry} first={!near} last={!nextSame} fresh={isFresh(m.id)} />);
    const h = m.senderType === "ai" ? handoffOf(m) : null;
    if (h) {
      const why = h.reason ? (HANDOFF_REASON[h.type] ?? h.reason) : undefined;
      rows.push(<EventRow key={`h-${m.id}`} icon={ArrowLeftRight} tone="warning" at={m.createdAt} fresh={isFresh(m.id)}>{why ? `Handoff requested: ${why}` : "Handoff requested"}</EventRow>);
    }
    prev = m; prevWho = w;
  });

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background px-3 py-4 sm:px-5"
      onScroll={(e) => { const t = e.currentTarget; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80; }}>
      {hasOlder && (
        <div className="mb-3 text-center">
          <Button variant="outline" size="sm" disabled={loadingOlder} onClick={onLoadOlder}><RotateCcw className="size-3.5" />{loadingOlder ? "Loading…" : "Load earlier messages"}</Button>
        </div>
      )}
      {messages.length === 0 && (
        <div className="grid place-items-center py-16 text-center text-muted-foreground">
          <UserRound className="mb-2 size-8" aria-hidden="true" />
          <p className="text-sm">No messages yet. Say hello below.</p>
        </div>
      )}
      <ol className="space-y-2" aria-live="polite" aria-label="Messages">
        {rows}
        {typing && <TypingBubble />}
      </ol>
    </div>
  );
}
