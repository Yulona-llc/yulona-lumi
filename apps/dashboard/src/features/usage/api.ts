import { req, send, qs, downloadAuthed } from "../integrations-ui/http";

/** All credit amounts on the wire are integer micro-credits (1 credit = 1_000_000 micro). */
export const MICRO = 1_000_000;

export interface CreditsInfo {
  mode: "saas" | "selfhosted"; enabled: boolean; unlimited: boolean; period: string;
  allowanceMicro: number | null; usedMicro: number; topupMicro: number; topupUsedMicro: number;
  remainingMicro: number | null; percentUsed: number | null;
  status: "ok" | "warning" | "exhausted"; warnings: string[];
}
export interface UsageRow { key: string; label: string; promptTokens: number; completionTokens: number; totalTokens: number; requests: number; creditsMicro: number }
export interface UsageReport { from: string; to: string; groupBy: GroupBy; items: UsageRow[]; totals: Omit<UsageRow, "key" | "label"> }
export type GroupBy = "day" | "agent" | "model" | "conversation";
export interface CreditPack { id: string; name: string; credits: number; priceCents: number; currency: string }

/** Query keys (own namespace: `["usage", n]` belongs to billing and has another shape). */
export const creditKeys = {
  credits: ["credits", "me"] as const,
  report: (groupBy: GroupBy, from: string, to: string) => ["credits", "report", groupBy, from, to] as const,
  packs: ["credits", "packs"] as const,
};

/** A response that is not a credits object (older server, or a prefix-matched test double) counts as "no credits info". */
export function asCredits(raw: unknown): CreditsInfo | null {
  const r = raw as Partial<CreditsInfo> | null;
  if (!r || typeof r !== "object" || (r.mode !== "saas" && r.mode !== "selfhosted") || typeof r.enabled !== "boolean") return null;
  return r as CreditsInfo;
}

export const creditsApi = {
  credits: () => req<unknown>("/usage/credits").then(asCredits),
  report: (groupBy: GroupBy, from: string, to: string) => req<UsageReport>(`/usage/ai${qs({ from, to, groupBy })}`),
  exportCsv: (groupBy: GroupBy, from: string, to: string) => downloadAuthed(`/usage/ai/export${qs({ from, to, groupBy })}`, `ai-usage-${from}_${to}.csv`),
  packs: () => req<{ items: CreditPack[] }>("/billing/credit-packs").then((r) => r.items),
  checkout: (packId: string) => req<{ url: string }>("/billing/credits/checkout", send("POST", { packId })),
};

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const toCredits = (micro: number) => micro / MICRO;
export const fmtCredits = (micro: number | null | undefined) => (micro == null ? "0" : nf.format(toCredits(micro)));
export const fmtNum = (n: number) => new Intl.NumberFormat().format(n);
export const fmtPrice = (cents: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`; }
};
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export function rangeFor(days: number, now = new Date()) {
  const to = isoDay(now); const from = isoDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  return { from, to };
}
/** First day of the month after `period` (YYYY-MM-01), shown as when the allowance resets. */
export function nextReset(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1)).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
}
