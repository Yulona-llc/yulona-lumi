import type { Tx } from "@yulona/db";
import { loadMessageEstimate, messagesLeft } from "./estimate";

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
  /** Average cost of one answered message, in credits (2 decimals); null when unlimited / selfhosted. */
  creditsPerMessage: number | null;
  /** Whole answered messages the remaining credits cover; null when unlimited / selfhosted. */
  estimatedMessages: number | null;
  /** "usage": the workspace's 30-day average; "typical": ~6k in / 0.6k out at the default rate. */
  estimateBasis: "usage" | "typical" | null;
}

const monthStart = () => new Date().toISOString().slice(0, 7) + "-01";

/** Pure mapping of a tenant_credits row to the API shape (shared by the tenant and admin endpoints). */
export function creditsDto(mode: DeploymentMode, row: CreditsRowRaw | null): CreditsDto {
  if (mode === "selfhosted" || !row) {
    return {
      mode, enabled: mode !== "selfhosted", unlimited: mode === "selfhosted", period: row?.period ?? monthStart(), allowanceMicro: null, usedMicro: 0, topupMicro: 0,
      topupUsedMicro: 0, remainingMicro: null, percentUsed: null, status: "ok", warnings: [],
      creditsPerMessage: null, estimatedMessages: null, estimateBasis: null,
    };
  }
  const allowance = row.allowanceMicro === null ? null : Number(row.allowanceMicro);
  const used = Number(row.usedMicro), topup = Number(row.topupMicro), topupUsed = Number(row.topupUsedMicro);
  const base = { mode, enabled: true, period: row.period, usedMicro: used, topupMicro: topup, topupUsedMicro: topupUsed };
  if (allowance === null) {
    return { ...base, unlimited: true, allowanceMicro: null, remainingMicro: null, percentUsed: null, status: "ok", warnings: [], creditsPerMessage: null, estimatedMessages: null, estimateBasis: null };
  }
  const remaining = allowance - used + topup;
  const pool = allowance + topupUsed + Math.max(topup, 0);
  const pct = pool > 0 ? ((used + topupUsed) * 100) / pool : 100;
  const status = remaining <= 0 ? "exhausted" : pct >= 80 ? "warning" : "ok";
  return {
    ...base, unlimited: false, allowanceMicro: allowance, remainingMicro: remaining, percentUsed: Math.round(pct * 10) / 10, status,
    warnings: status === "exhausted" ? ["warning_80", "exhausted"] : status === "warning" ? ["warning_80"] : [],
    creditsPerMessage: null, estimatedMessages: null, estimateBasis: null,
  };
}

/** Current period's credits for the tenant behind `tx` (creates the period row; nothing is created for self-hosted). */
export async function loadCredits(tx: Tx, tenantId: string, mode: DeploymentMode): Promise<CreditsDto> {
  if (mode === "selfhosted") return creditsDto(mode, null);
  const [row] = await tx<CreditsRowRaw[]>`
    SELECT to_char(period, 'YYYY-MM-DD') AS period, allowance_micro, used_micro, topup_micro, topup_used_micro FROM credits_sync(${tenantId}::uuid)`;
  const dto = creditsDto(mode, row ?? null);
  if (!dto.enabled || dto.unlimited || dto.remainingMicro === null) return dto;
  const est = await loadMessageEstimate(tx, tenantId);
  return {
    ...dto, estimateBasis: est.basis, creditsPerMessage: Math.round(est.creditsPerMessageMicro / 10_000) / 100,
    estimatedMessages: messagesLeft(dto.remainingMicro, est.creditsPerMessageMicro),
  };
}
