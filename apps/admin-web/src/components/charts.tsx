import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { fmtDay, nf, pctDelta } from "@/lib/format";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

const BRAND = "var(--chart-1)";

/** Tiny trend line for KPI tiles. */
export function Sparkline({ data, className }: { data: number[]; className?: string }) {
  const id = useId();
  if (data.length < 2) return <div className={cn("h-8", className)} />;
  const W = 120, H = 32, max = Math.max(1, ...data), min = Math.min(0, ...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * W, H - 3 - ((v - min) / (max - min || 1)) * (H - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("h-8 w-full", className)} preserveAspectRatio="none" role="img" aria-label={`Trend, ${data.length} days`}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={BRAND} stopOpacity=".28" /><stop offset="1" stopColor={BRAND} stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={BRAND} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** "+12% vs previous 30 days": direction is always spelled out, not colour only. `good` flips the tone (more suspended is bad). */
export function Delta({ cur, prev, good = "up", label = "vs prior 30 days" }: { cur: number; prev: number; good?: "up" | "down"; label?: string }) {
  const d = pctDelta(cur, prev);
  if (d === null) return <span className="text-xs text-muted-foreground">No earlier data to compare</span>;
  const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const tone = dir === "flat" ? "text-muted-foreground" : dir === good ? "text-success" : "text-destructive";
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", tone)}><Icon className="size-3.5" aria-hidden />{d > 0 ? "+" : ""}{d}%</span>{label}</span>;
}

/** Daily bars with hover readout and a table fallback. */
export function BarSeries({ data, label, unit = "", height = 140 }: { data: Array<{ x: string; y: number }>; label: string; unit?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...data.map((d) => d.y));
  const slots = Math.max(data.length, 14), offset = slots - data.length;
  const W = 600, pad = 2, bw = Math.max(2, (W - pad * (slots - 1)) / slots);
  const cur = hover !== null ? data[hover] : null;
  const total = data.reduce((s, d) => s + d.y, 0);
  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground" aria-live="polite">{cur ? `${fmtDay(cur.x)}: ${nf.format(cur.y)}${unit}` : `Total ${nf.format(Math.round(total * 100) / 100)}${unit}`}</span>
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
      <button type="button" className="mt-1 min-h-8 text-xs font-medium text-accent-foreground underline underline-offset-4" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show as table"}</button>
    </figure>
  );
}

/** Horizontal labelled bars (plan mix). Direct value labels; one hue. */
export function HBars({ rows, label }: { rows: Array<{ k: string; v: number }>; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <figure className="m-0"><figcaption className="mb-3 text-sm font-medium">{label}</figcaption>
      <ul className="space-y-2">{rows.map((r, i) => (
        <li key={r.k} className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground" title={r.k}>{r.k}</span>
          <span className="h-4 rounded-r bg-muted"><span className="block h-4 rounded-r" style={{ width: `${(r.v / max) * 100}%`, background: BRAND, opacity: 1 - i * 0.1 }} /></span>
          <span className="text-right tabular-nums">{nf.format(r.v)}</span></li>))}</ul></figure>
  );
}

export function Meter({ used, limit, warning }: { used: number; limit: number | null; warning?: boolean }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const over = limit !== null && used >= limit;
  const state = over ? "At limit" : warning || pct >= 80 ? "Near limit" : "";
  return (
    <div>
      <div className="flex justify-between text-sm"><span className="tabular-nums">{nf.format(used)} / {limit === null ? "unlimited" : nf.format(limit)}</span>{state && <span className={cn("font-medium", over ? "text-destructive" : "text-warning")}>{state}</span>}</div>
      <div role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Usage" className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-1.5 rounded-full" style={{ width: `${limit === null ? 0 : pct}%`, background: over ? "var(--destructive)" : BRAND }} /></div>
    </div>
  );
}

/** Stacked health-bucket bar with a legend that also carries the numbers. */
export function BucketBar({ counts }: { counts: { healthy: number; watch: number; at_risk: number } }) {
  const total = counts.healthy + counts.watch + counts.at_risk;
  const parts = [["healthy", "Healthy", "var(--success)"], ["watch", "Watch", "var(--warning)"], ["at_risk", "At risk", "var(--destructive)"]] as const;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map(([k, l]) => `${l} ${counts[k]}`).join(", ")}>
        {parts.map(([k, , c]) => counts[k] > 0 && <span key={k} style={{ width: `${(counts[k] / Math.max(1, total)) * 100}%`, background: c }} />)}
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2 text-sm">
        {parts.map(([k, l, c]) => <li key={k}><span className="flex items-center gap-1.5 text-muted-foreground"><span className="size-2 rounded-full" style={{ background: c }} aria-hidden />{l}</span><span className="font-display text-xl font-semibold tabular-nums">{counts[k]}</span></li>)}
      </ul>
    </div>
  );
}
