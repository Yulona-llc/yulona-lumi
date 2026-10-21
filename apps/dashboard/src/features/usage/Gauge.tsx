import { useEffect, useState } from "react";
import { AnimatedNumber } from "@/components/motion";
import { cn } from "@/lib/utils";
import { fmtCredits, toCredits } from "./api";

const ARC = 75; // 270 degrees of a 360 degree ring, expressed against pathLength 100

/**
 * The Usage page's one memorable element: a calm 270 degree ring. The ember arc grows from empty on first paint
 * (CSS transition, off for reduced motion); it turns amber at 80% and red when exhausted. Colour is always paired with text.
 */
export function Gauge({ remainingMicro, percent, status, unlimited }: { remainingMicro: number | null; percent: number | null; status: "ok" | "warning" | "exhausted"; unlimited?: boolean }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = requestAnimationFrame(() => setShown(pct)); return () => cancelAnimationFrame(t); }, [pct]);
  const tone = status === "exhausted" ? "var(--destructive)" : status === "warning" ? "var(--warning)" : "var(--primary)";
  const common = { cx: 60, cy: 60, r: 52, fill: "none", strokeWidth: 9, strokeLinecap: "round" as const, pathLength: 100, transform: "rotate(135 60 60)" };
  const label = unlimited ? "Unlimited credits" : `${fmtCredits(remainingMicro)} credits left, ${Math.round(pct)}% used`;
  return (
    <div className="relative mx-auto aspect-[120/104] w-full max-w-[17rem]" role="img" aria-label={label}>
      <svg viewBox="0 0 120 104" className="size-full" aria-hidden>
        <circle {...common} stroke="var(--muted)" strokeDasharray={`${ARC} 100`} />
        {!unlimited && (
          <circle {...common} stroke={tone} strokeDasharray={`${(ARC * shown) / 100} 100`} className={cn("transition-[stroke-dasharray] duration-1000 ease-out motion-reduce:transition-none", pct === 0 && "opacity-0")} />
        )}
      </svg>
      <div className="absolute inset-x-0 top-[57.7%] flex -translate-y-1/2 flex-col items-center justify-center px-6 text-center">
        {unlimited ? (
          <p className="font-display text-3xl font-semibold tracking-tight">Unlimited</p>
        ) : (
          <p className="font-display text-5xl font-semibold tabular-nums tracking-tight sm:text-6xl">
            <AnimatedNumber value={toCredits(remainingMicro ?? 0)} format={(n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(n))} />
          </p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">{unlimited ? "AI credits on your plan" : "credits left"}</p>
        {!unlimited && <p className={cn("mt-2 text-sm font-medium tabular-nums", status === "exhausted" ? "text-destructive" : status === "warning" ? "text-warning" : "text-muted-foreground")}>{Math.round(pct)}% used</p>}
      </div>
    </div>
  );
}
