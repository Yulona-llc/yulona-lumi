const MICRO = 1_000_000;
export const nf = new Intl.NumberFormat();
export const fmtNum = (n: number) => nf.format(n);
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never");
export const fmtDay = (s: string) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const fmtCredits = (micro: number | null | undefined) => (micro == null ? "Unlimited" : nf.format(Math.round((micro / MICRO) * 100) / 100));
export const fmtMoney = (cents: number, currency = "usd") => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`; }
};
/** "3h ago", "12d ago", "just now"; "Never" for null. */
export function ago(s: string | null | undefined, now = Date.now()): string {
  if (!s) return "Never";
  const sec = Math.max(0, Math.round((now - new Date(s).getTime()) / 1000));
  if (sec < 60) return "just now";
  const m = Math.round(sec / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
/** Percent change vs the previous period; null when there is no baseline. */
export function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 100);
}
export const titleCase = (s: string) => s.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
export const typicalMessageCredits = (inMicro: number, outMicro: number) => Math.ceil((6000 * inMicro + 600 * outMicro) / 1000) / MICRO;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The API returns only days that have data; chart the last `days` UTC days with zeros filled in. `scale` converts units (micro-credits to credits). */
export function fillDays(series: Array<{ day: string; value: number }>, days: number, scale = 1, now = new Date()): Array<{ x: string; y: number }> {
  const by = new Map(series.map((p) => [p.day.slice(0, 10), Number(p.value)]));
  const out: Array<{ x: string; y: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const x = isoDay(new Date(now.getTime() - i * 86_400_000));
    out.push({ x, y: (by.get(x) ?? 0) * scale });
  }
  return out;
}
export const MICRO_CREDITS = MICRO;
export { MICRO_CREDITS as MICRO };
export const fmtPrice = fmtMoney;
