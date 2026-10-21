import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, MessageSquareText, SendHorizontal, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FALLBACK_CANNED, inboxApi } from "./api";
import { realtime } from "../realtime/socket";

export default function Composer({ conversationId, handler, disabled, onSend }: {
  conversationId: string; handler: "ai" | "human"; disabled?: boolean; onSend: (text: string, kind: "reply" | "note") => void;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"reply" | "note">("reply");
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const canned = useQuery({ queryKey: ["canned"], queryFn: inboxApi.canned, staleTime: 5 * 60_000, retry: false });
  const list = canned.data?.length ? canned.data : FALLBACK_CANNED;

  // "/shortcut" opens the canned-response picker.
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const matches = useMemo(
    () => (slash === null ? [] : list.filter((c) => c.title.toLowerCase().includes(slash) || (c.shortcut ?? "").toLowerCase().startsWith(slash)).slice(0, 6)),
    [slash, list],
  );

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, kind);
    setText("");
  };
  const pick = (body: string) => { setText(body); ta.current?.focus(); };
  const note = kind === "note";

  return (
    <form className={cn("shrink-0 border-t bg-card p-3 transition-colors", note && "bg-warning/5")} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <div role="radiogroup" aria-label="Send as" className="inline-flex rounded-xl bg-muted p-1">
          {(["reply", "note"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={cn("inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/35 sm:min-h-8",
                kind === k ? (k === "note" ? "bg-warning/15 text-warning shadow-sm" : "bg-card text-foreground shadow-sm") : "text-muted-foreground hover:text-foreground")}>
              {k === "note" ? <Lock className="size-3.5" aria-hidden="true" /> : <MessageSquareText className="size-3.5" aria-hidden="true" />}
              {k === "reply" ? "Reply to customer" : "Internal note"}
            </button>
          ))}
        </div>
        <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
          {note ? "Only your team sees notes." : handler === "ai" ? "Sending a reply takes over from the AI." : ""}
        </p>
      </div>
      <div className="relative">
        {matches.length > 0 && (
          <ul role="listbox" aria-label="Canned responses" className="absolute bottom-full z-10 mb-2 w-full overflow-hidden rounded-xl border bg-popover p-1 shadow-lg">
            {matches.map((c) => (
              <li key={c.id} role="option" aria-selected="false">
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted" onClick={() => pick(c.body)}>
                  <span className="text-sm font-medium">{c.title}{c.shortcut && <span className="ml-2 font-mono text-xs text-muted-foreground">/{c.shortcut}</span>}</span>
                  <span className="block truncate text-xs text-muted-foreground">{c.body}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="composer" className="sr-only">Message</label>
        <Textarea id="composer" ref={ta} rows={2} maxLength={4000} disabled={disabled}
          className={cn("max-h-40 min-h-16 resize-none", note && "border-warning/60 bg-warning/5")}
          placeholder={disabled ? "This conversation is resolved. Reopen it to reply." : note ? "Write an internal note…" : "Write a reply…  (type / for canned responses)"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const now = Date.now();
            if (kind === "reply" && now - lastTyping.current > 3000) { lastTyping.current = now; realtime.sendTyping(conversationId, true); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" disabled={disabled}><Zap />Canned responses</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="max-h-72 w-72 overflow-y-auto">
            <DropdownMenuLabel>Insert a saved reply</DropdownMenuLabel>
            {list.map((c) => (
              <DropdownMenuItem key={c.id} className="flex-col items-start gap-0.5" onSelect={() => pick(c.body)}>
                <span className="font-medium">{c.title}</span><span className="line-clamp-1 text-xs text-muted-foreground">{c.body}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-3">
          <span className="hidden whitespace-nowrap text-xs text-muted-foreground @5xl:inline"><kbd className="rounded border bg-muted px-1.5 font-mono">Ctrl</kbd> + <kbd className="rounded border bg-muted px-1.5 font-mono">Enter</kbd> to send</span>
          <Button type="submit" variant={note ? "secondary" : "default"} disabled={!text.trim() || disabled}>
            {!note && <SendHorizontal />}{note ? "Add note" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}
