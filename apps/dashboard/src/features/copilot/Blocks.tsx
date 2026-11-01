import { Link } from "react-router";
import { ArrowRight, Check, Circle } from "lucide-react";
import type { CopilotBlock } from "@yulona/shared";
import { Button } from "@/components/ui/button";

interface Handlers { onChoice: (text: string) => void; onConfirm: (token: string) => void; onCancel: (token: string) => void; busy: boolean; resolved: Set<string> }
const safePath = (p: string) => (p.startsWith("/") && !p.startsWith("//") ? p : "/overview");

/**
 * Whitelisted renderers for the structured blocks of an assistant message. Everything is plain text in React elements;
 * unknown block types render nothing. The model can never inject markup.
 */
const RENDER: Record<CopilotBlock["type"], (b: never, h: Handlers) => React.ReactNode> = {
  chips: ((b: Extract<CopilotBlock, { type: "chips" }>, h: Handlers) => (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested replies">
      {b.options.slice(0, 6).map((o) => <button key={o} type="button" disabled={h.busy} onClick={() => h.onChoice(o)} className="min-h-9 rounded-full border bg-background px-3.5 text-sm font-medium outline-none transition-colors hover:border-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50">{o}</button>)}
    </div>
  )) as never,
  checklist: ((b: Extract<CopilotBlock, { type: "checklist" }>) => (
    <ul className="space-y-1.5 rounded-xl border bg-background p-3 text-sm" aria-label="Checklist">
      {b.items.slice(0, 10).map((i) => (
        <li key={i.label} className="flex items-center gap-2.5">
          {i.done ? <Check className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-muted-foreground" aria-label="To do" />}
          {i.path && !i.done ? <Link to={safePath(i.path)} className="font-medium underline-offset-4 hover:underline">{i.label}</Link> : <span className={i.done ? "text-muted-foreground line-through" : ""}>{i.label}</span>}
        </li>
      ))}
    </ul>
  )) as never,
  diff: ((b: Extract<CopilotBlock, { type: "diff" }>) => (
    <div className="rounded-xl border bg-background p-3 text-sm" aria-label={b.title}>
      <p className="font-medium">{b.title}</p>
      <dl className="mt-2 space-y-2">
        {b.changes.slice(0, 8).map((c) => (
          <div key={c.field}><dt className="text-xs font-medium text-muted-foreground">{c.field}</dt><dd className="break-words"><span className="text-muted-foreground line-through">{c.before}</span> <ArrowRight className="mx-0.5 inline size-3.5" aria-hidden /> <span>{c.after}</span></dd></div>
        ))}
      </dl>
    </div>
  )) as never,
  preview: ((b: Extract<CopilotBlock, { type: "preview" }>) => (
    <div className="rounded-xl border bg-background p-3 text-sm"><p className="font-medium">{b.title}</p><ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">{b.lines.slice(0, 8).map((l) => <li key={l} className="break-words">{l}</li>)}</ul></div>
  )) as never,
  confirm: ((b: Extract<CopilotBlock, { type: "confirm" }>, h: Handlers) => {
    const done = h.resolved.has(b.token);
    const expired = new Date(b.expiresAt).getTime() < Date.now();
    return (
      <div className="rounded-xl border border-primary/50 bg-accent/40 p-3 text-sm" role="group" aria-label="Confirmation needed" data-testid="confirm-card">
        <p className="font-medium">{b.title}</p>
        <p className="mt-0.5 text-muted-foreground">{b.summary}</p>
        {done ? <p className="mt-2 text-muted-foreground">Answered.</p> : expired ? <p className="mt-2 text-muted-foreground">This confirmation expired. Ask again.</p> : (
          <div className="mt-3 flex gap-2"><Button size="sm" disabled={h.busy} onClick={() => h.onConfirm(b.token)}>Confirm</Button><Button size="sm" variant="outline" disabled={h.busy} onClick={() => h.onCancel(b.token)}>Not now</Button></div>
        )}
      </div>
    );
  }) as never,
  link: ((b: Extract<CopilotBlock, { type: "link" }>) => <Button asChild size="sm" variant="outline" className="w-fit"><Link to={safePath(b.path)}>{b.label}<ArrowRight /></Link></Button>) as never,
};

export function Blocks({ blocks, ...h }: { blocks: CopilotBlock[] } & Handlers) {
  return <div className="mt-2 space-y-2">{blocks.slice(0, 6).map((b, i) => { const r = RENDER[b.type]; return r ? <div key={i}>{r(b as never, h)}</div> : null; })}</div>;
}
