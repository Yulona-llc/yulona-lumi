import { useId } from "react";
import { AnimatedNumber } from "@/components/motion";
import { Card } from "@/components/ui/card";

/** Hand-written SVG area sparkline. Single hue, direct total label, text summary for screen readers. */
export function SparkCard({ label, values, days }: { label: string; values: number[]; days: number }) {
  const id = useId();
  const total = values.reduce((a, b) => a + b, 0);
  const W = 240, H = 56, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * W : W / 2, H - 4 - (v / max) * (H - 10)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = pts.length ? `${line} L${W},${H} L0,${H} Z` : "";
  const half = Math.floor(values.length / 2);
  const a = values.slice(0, half).reduce((s, v) => s + v, 0), b = values.slice(half).reduce((s, v) => s + v, 0);
  const trend = a > 0 ? Math.round(((b - a) / a) * 100) : null;
  return (
    <Card className="gap-2 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {trend !== null && <p className={`text-xs tabular-nums ${trend >= 0 ? "text-success" : "text-muted-foreground"}`}>{trend >= 0 ? "Up" : "Down"} {Math.abs(trend)}%</p>}
      </div>
      <p className="font-display text-3xl font-semibold tabular-nums tracking-tight"><AnimatedNumber value={total} /></p>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" role="img" aria-label={`${label}, last ${days} days, total ${total}`} preserveAspectRatio="none">
        <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.28" /><stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" /></linearGradient></defs>
        {pts.length > 0 && <><path d={area} fill={`url(#${id})`} /><path d={line} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /></>}
        {pts.length === 0 && <line x1="0" x2={W} y1={H - 2} y2={H - 2} stroke="var(--border)" />}
      </svg>
    </Card>
  );
}

/** Fill the last `days` days (UTC) so quiet days read as zero. */
export function dailyValues(series: Array<{ day: string; metric: string; value: number }>, metric: string, days: number): number[] {
  const m = new Map(series.filter((s) => s.metric === metric).map((s) => [s.day, s.value]));
  const out: number[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(m.get(d.toISOString().slice(0, 10)) ?? 0);
  }
  return out;
}
