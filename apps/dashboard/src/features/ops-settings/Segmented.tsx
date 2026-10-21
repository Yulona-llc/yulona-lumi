import { useId, type ReactNode } from "react";
import { motion } from "@/components/motion";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; name?: string; count?: number }

/** Segmented control (buttons with aria-pressed). The active pill slides between options. */
export function Segmented<T extends string>({ value, onChange, options, label, className, scroll }: {
  value: T; onChange: (v: T) => void; options: Array<SegmentedOption<T>>; label: string; className?: string; scroll?: boolean;
}) {
  const id = useId();
  return (
    <div role="group" aria-label={label} className={cn("inline-flex items-center gap-1 rounded-xl bg-muted p-1", scroll && "scrollbar-none max-w-full overflow-x-auto", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} aria-label={o.name} onClick={() => onChange(o.value)}
            className={cn("relative inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:min-h-8", on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {on && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-lg bg-card shadow-sm" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span className="relative z-10 inline-flex items-center gap-1.5">{o.label}{o.count !== undefined && <span className="tabular-nums text-xs text-muted-foreground">{o.count}</span>}</span>
          </button>
        );
      })}
    </div>
  );
}
