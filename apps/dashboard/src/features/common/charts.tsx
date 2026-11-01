import { useState } from "react";
import { Card } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/motion";
import { cn } from "@/lib/utils";

/** Lightweight SVG charts. Single hue (ember), thin marks, hover/focus readout, table fallback. */
const BRAND = "var(--chart-1)";
const nf = new Intl.NumberFormat();

export function BarSeries({ data, label, unit = "", height = 140 }: { data: Array<{ x: string; y: number }>; label: string; unit?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.y));
  // At least 14 slots, newest on the right: one lonely day must not stretch into a block the width of the chart.
  const slots = Math.max(data.length, 14), offset = slots - data.length;
  const W = 600, pad = 2, bw = Math.max(2, (W - pad * (slots - 1)) / slots);
  const cur = hover !== null ? data[hover] : null;
  const total = data.reduce((s, d) => s + d.y, 0);
  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">{cur ? `${cur.x}: ${nf.format(cur.y)}${unit}` : `Total ${nf.format(total)}${unit}`}</span>
      </figcaption>
      {data.length === 0 ? <p className="py-6 text-sm text-muted-foreground">No data for this period.</p> : table ? (
        <div className="max-h-48 overflow-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{label}</caption><thead><tr><th scope="col">Day</th><th scope="col" className="text-right">Value</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.x}><td>{d.x}</td><td className="text-right tabular-nums">{nf.format(d.y)}</td></tr>)}</tbody></table></div>
      ) : (
        <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={`${label}, ${data.length} points, max ${nf.format(max)}`} onMouseLeave={() => setHover(null)}>
          <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" />
          {data.map((d, i) => {
            const h = Math.max(d.y > 0 ? 2 : 0, (d.y / max) * (height - 8));
            return <g key={d.x} onMouseEnter={() => setHover(i)}>
              <rect x={(i + offset) * (bw + pad)} y={0} width={bw + pad} height={height} fill="transparent" />
              <rect x={(i + offset) * (bw + pad)} y={height - h} width={bw} height={h} rx={Math.min(4, bw / 2)} fill={BRAND} opacity={hover === null || hover === i ? 1 : 0.45} />
            </g>;
          })}
        </svg>
      )}
      <button type="button" className="mt-1 min-h-8 text-sm font-medium text-accent-foreground underline underline-offset-4" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show as table"}</button>
    </figure>
  );
}

/** Horizontal labeled bars (funnel, plan mix). Direct value labels; one hue. */
export function HBars({ rows, label }: { rows: Array<{ k: string; v: number }>; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <figure className="m-0"><figcaption className="mb-3 text-sm font-medium">{label}</figcaption>
      <ul className="space-y-2">{rows.map((r, i) => (
        <li key={r.k} className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-3 text-sm sm:grid-cols-[7rem_1fr_3.5rem]">
          <span className="truncate text-muted-foreground" title={r.k}>{r.k}</span>
          <span className="h-5 rounded-r bg-muted"><span className="block h-5 rounded-r" style={{ width: `${(r.v / max) * 100}%`, background: BRAND, opacity: 1 - i * 0.08 }} /></span>
          <span className="text-right tabular-nums">{nf.format(r.v)}</span></li>))}</ul></figure>
  );
}

/** Number tile. `value` is shown as given (already formatted) unless `count` is passed, which counts up. */
export function Stat({ label, value, hint, count, className }: { label: string; value?: string; hint?: string; count?: number; className?: string }) {
  return (
    <Card className={cn("gap-1 p-4", className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-display text-3xl font-semibold tabular-nums tracking-tight">{count !== undefined ? <AnimatedNumber value={count} /> : value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Usage meter. Status color is paired with a text label, never color alone. */
export function Meter({ used, limit, warning }: { used: number; limit: number | null; warning?: boolean }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const over = limit !== null && used >= limit;
  const state = over ? "At limit" : warning || pct >= 80 ? "Near limit" : "";
  return (
    <div>
      <div className="flex justify-between text-sm"><span className="tabular-nums">{nf.format(used)} / {limit === null ? "unlimited" : nf.format(limit)}</span>{state && <span className={cn("font-medium", over ? "text-destructive" : "text-warning")}>{state}</span>}</div>
      <div role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Usage" className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full" style={{ width: `${limit === null ? 0 : pct}%`, background: over ? "var(--destructive)" : BRAND }} /></div>
    </div>
  );
}
