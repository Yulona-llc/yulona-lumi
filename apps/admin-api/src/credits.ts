export type DeploymentMode = "saas" | "selfhosted";

export interface CreditsRowRaw {
  period: string;
  allowanceMicro: string | null;
  usedMicro: string;
  topupMicro: string;
  topupUsedMicro: string;
}
export interface CreditsDto {
  mode: DeploymentMode;
  enabled: boolean;
  unlimited: boolean;
  period: string;
  allowanceMicro: number | null;
  usedMicro: number;
  topupMicro: number;
  topupUsedMicro: number;
  remainingMicro: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "exhausted";
  warnings: ("warning_80" | "exhausted")[];
}
const monthStart = () => new Date().toISOString().slice(0, 7) + "-01";

/** Pure mapping of a tenant_credits row (same maths as the customer API's credits endpoint). */
export function creditsDto(mode: DeploymentMode, row: CreditsRowRaw | null): CreditsDto {
  if (mode === "selfhosted" || !row) {
    return { mode, enabled: mode !== "selfhosted", unlimited: mode === "selfhosted", period: row?.period ?? monthStart(), allowanceMicro: null, usedMicro: 0, topupMicro: 0,
      topupUsedMicro: 0, remainingMicro: null, percentUsed: null, status: "ok", warnings: [] };
  }
  const allowance = row.allowanceMicro === null ? null : Number(row.allowanceMicro);
  const used = Number(row.usedMicro), topup = Number(row.topupMicro), topupUsed = Number(row.topupUsedMicro);
  const base = { mode, enabled: true, period: row.period, usedMicro: used, topupMicro: topup, topupUsedMicro: topupUsed };
  if (allowance === null) return { ...base, unlimited: true, allowanceMicro: null, remainingMicro: null, percentUsed: null, status: "ok", warnings: [] };
  const remaining = allowance - used + topup;
  const pool = allowance + topupUsed + Math.max(topup, 0);
  const pct = pool > 0 ? ((used + topupUsed) * 100) / pool : 100;
  const status = remaining <= 0 ? "exhausted" : pct >= 80 ? "warning" : "ok";
  return { ...base, unlimited: false, allowanceMicro: allowance, remainingMicro: remaining, percentUsed: Math.round(pct * 10) / 10, status,
    warnings: status === "exhausted" ? ["warning_80", "exhausted"] : status === "warning" ? ["warning_80"] : [] };
}
