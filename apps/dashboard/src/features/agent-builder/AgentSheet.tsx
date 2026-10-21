import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { motion } from "@/components/motion";
import { cn } from "@/lib/utils";
import type { BuilderDraft } from "./api";
import { filledCount, sheetRows } from "./model";

/** The live agent sheet: a spec that fills in as the assistant learns. Changed rows flash once. */
export function AgentSheet({ draft, className }: { draft: BuilderDraft; className?: string }) {
  const rows = sheetRows(draft);
  const prev = useRef<Record<string, string | null>>({});
  const changed = new Set(rows.filter((r) => r.value !== null && prev.current[r.key] !== undefined && prev.current[r.key] !== r.value).map((r) => r.key));
  useEffect(() => { prev.current = Object.fromEntries(rows.map((r) => [r.key, r.value])); });
  return (
    <div className={cn("space-y-1", className)}>
      <h2 className="font-display text-lg font-semibold">Agent sheet</h2>
      <p className="pb-2 text-sm text-muted-foreground" aria-live="polite">{filledCount(rows)} of {rows.length} covered. It fills in as we talk.</p>
      <dl className="divide-y rounded-xl border bg-card">
        {rows.map((r) => (
          <motion.div key={r.key} className="px-4 py-3" data-testid={`sheet-${r.key}`}
            initial={false} animate={{ backgroundColor: changed.has(r.key) ? ["var(--accent)", "rgba(0,0,0,0)"] : "rgba(0,0,0,0)" }} transition={{ duration: 1.4 }}>
            <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {r.value !== null ? <Check className="size-3.5 text-success" aria-hidden /> : <span className="size-3.5 rounded-full border border-dashed" aria-hidden />}
              {r.label}
            </dt>
            <dd className={cn("mt-1 whitespace-pre-line break-words text-sm", r.value === null && "text-muted-foreground/70 italic")}>{r.value ?? r.hint}</dd>
          </motion.div>
        ))}
      </dl>
    </div>
  );
}
