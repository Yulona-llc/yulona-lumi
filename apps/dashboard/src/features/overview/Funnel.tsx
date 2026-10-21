import { motion } from "@/components/motion";
import { AnimatedNumber, ease } from "@/components/motion";
import type { FunnelStep } from "./api";

/** The conversion funnel as a living shape: centred bars that narrow with each step and grow in on first view. */
export function Funnel({ steps }: { steps: FunnelStep[] }) {
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <ol aria-label="Conversion funnel" className="flex flex-col items-stretch">
      {steps.map((s, i) => {
        const prev = steps[i - 1];
        const pct = Math.max(s.count ? 46 : 36, Math.round((s.count / top) * 100));
        const drop = prev && prev.count > 0 ? Math.round((1 - s.count / prev.count) * 100) : null;
        const last = i === steps.length - 1;
        return (
          <li key={s.key}>
            {drop !== null && (
              <p className="py-1.5 text-center text-xs text-muted-foreground tabular-nums">
                {prev!.count === 0 ? "" : drop <= 0 ? "Everyone continued" : `${drop}% dropped off`}
              </p>
            )}
            <div className="flex justify-center">
              <motion.div
                data-testid={`funnel-${s.key}`}
                style={{ width: `${pct}%`, transformOrigin: "center" }}
                initial={{ scaleX: 0.15, opacity: 0 }}
                whileInView={{ scaleX: 1, opacity: 1 }}
                viewport={{ once: true, margin: "-8% 0px" }}
                transition={{ duration: 0.7, delay: i * 0.12, ease }}
                className={`flex min-h-14 items-center justify-between gap-3 rounded-2xl px-4 py-2.5 ${last ? "bg-success text-white dark:text-[#06210f]" : "bg-primary text-primary-foreground"}`}
              >
                <span className="min-w-0 truncate text-sm font-medium">{s.label}</span>
                <span className="font-display text-xl font-semibold tabular-nums"><AnimatedNumber value={s.count} /></span>
              </motion.div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
