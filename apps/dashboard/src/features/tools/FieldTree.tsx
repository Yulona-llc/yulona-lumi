import { useState } from "react";
import { Check, ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FieldNode, FieldTree as Tree } from "./api";

const TYPE_WORD: Record<string, string> = { string: "text", number: "number", boolean: "yes/no", object: "group", array: "list", null: "empty" };
const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? `"${v}"` : String(v));

function Node({ n, depth, mapped, onPick }: { n: FieldNode; depth: number; mapped: Set<string>; onPick: (n: FieldNode) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const has = !!n.children?.length;
  const on = mapped.has(n.path);
  return (
    <li>
      <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 0.875}rem` }}>
        {has ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${n.name}`} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted">
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
        ) : <span className="size-8 shrink-0" aria-hidden />}
        <button
          type="button" onClick={() => onPick(n)} aria-pressed={on} title={n.path}
          className={cn("group flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none sm:min-h-9", on ? "border-primary/60 bg-accent text-accent-foreground" : "border-transparent hover:border-border hover:bg-muted/60")}
        >
          <span className="font-mono text-[0.8125rem] font-medium">{n.name || "(each item)"}</span>
          <span className="text-xs text-muted-foreground">{n.type === "array" ? `list of ${n.length ?? 0}${n.itemType && !has ? `, ${TYPE_WORD[n.itemType] ?? n.itemType}` : ""}` : TYPE_WORD[n.type] ?? n.type}</span>
          {n.sample !== undefined && !has && <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground">{show(n.sample)}</span>}
          <span className={cn("ml-auto grid size-6 shrink-0 place-items-center rounded-full", on ? "bg-primary text-primary-foreground" : "text-muted-foreground opacity-60 group-hover:opacity-100")} aria-hidden>{on ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}</span>
          <span className="sr-only">{on ? "Remove from read back" : "Add to read back"}</span>
        </button>
      </div>
      {has && open && <ul className="mt-0.5 space-y-0.5">{n.children!.map((c) => <Node key={c.path} n={c} depth={depth + 1} mapped={mapped} onPick={onPick} />)}</ul>}
    </li>
  );
}

/** The answer from the customer's system as a tree. Clicking a field adds or removes it from "what the AI should read back". */
export function FieldTreeView({ tree, mapped, onPick }: { tree: Tree; mapped: Set<string>; onPick: (n: FieldNode) => void }) {
  if (!tree.fields.length) return <p className="text-sm text-muted-foreground">The answer had no fields to pick.</p>;
  return (
    <div>
      {tree.rootType === "array" && <p className="mb-1.5 text-xs text-muted-foreground">The answer is a list. Each field below is read from every item.</p>}
      <ul className="space-y-0.5" aria-label="Fields in the answer">{tree.fields.map((n) => <Node key={n.path} n={n} depth={0} mapped={mapped} onPick={onPick} />)}</ul>
    </div>
  );
}
