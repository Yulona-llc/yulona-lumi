import type { Tx } from "@yulona/db";
import type { CopilotAllowance, CopilotStatus } from "@yulona/shared";
import { AppError } from "../errors";

export const MAX_USER_MESSAGES = 40;
export const MAX_SESSION_TOKENS = 60_000;
export const MAX_MONTHLY_MESSAGES = 500;
export const MAX_TOOL_ROUNDS = 3;
export const COPILOT_MAX_TOKENS = 600;

const monthStartSql = (tx: Tx) => tx`date_trunc('month', now() AT TIME ZONE 'UTC')`;
export const nextMonthIso = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

/** Paying = billing_customers.status active/trialing AND plan_key set and not free. */
export async function isPaying(tx: Tx, tenantId: string): Promise<boolean> {
  const [b] = await tx<{ ok: boolean }[]>`
    SELECT (status IN ('active','trialing') AND plan_key IS NOT NULL AND plan_key <> 'free') AS ok FROM billing_customers WHERE tenant_id = ${tenantId}`;
  return !!b?.ok;
}

/** Micro-credits used by the copilot this UTC month (separate from chat credits). */
export async function copilotUsedMicro(tx: Tx, tenantId: string): Promise<number> {
  const [r] = await tx<{ n: string }[]>`
    SELECT COALESCE(sum(credits_micro), 0)::bigint AS n FROM ai_usage_events
    WHERE tenant_id = ${tenantId} AND source = 'copilot' AND at >= ${monthStartSql(tx)} AT TIME ZONE 'UTC'`;
  return Number(r?.n ?? 0);
}

export async function copilotAllowance(tx: Tx, tenantId: string): Promise<CopilotAllowance> {
  const [l] = await tx<{ limitValue: string | null }[]>`
    SELECT pl.limit_value FROM tenants t JOIN plan_limits pl ON pl.plan_key = t.plan_key AND pl.metric = 'copilot_credits_monthly' WHERE t.id = ${tenantId}`;
  const limitCredits = l && l.limitValue !== null ? Number(l.limitValue) : null;
  const usedMicro = await copilotUsedMicro(tx, tenantId);
  return { limitCredits, usedMicro, remainingMicro: limitCredits === null ? null : Math.max(0, limitCredits * 1_000_000 - usedMicro), resetsAt: nextMonthIso() };
}

export type Access = { allowed: true } | { allowed: false; reason: "requires_plan" };

export async function copilotAccess(tx: Tx, tenantId: string, mode: "saas" | "selfhosted"): Promise<Access> {
  if (mode === "selfhosted") return { allowed: true };
  return (await isPaying(tx, tenantId)) ? { allowed: true } : { allowed: false, reason: "requires_plan" };
}

/** Throws 402 copilot_requires_plan / copilot_limit_reached. Self-hosted: never charged or limited by the allowance. */
export async function assertCopilotAllowed(tx: Tx, tenantId: string, mode: "saas" | "selfhosted"): Promise<CopilotAllowance> {
  const a = await copilotAccess(tx, tenantId, mode);
  if (!a.allowed) throw new AppError(402, "copilot_requires_plan", "Ask Lumi is included in paid plans. Upgrade to use it.", { upgradePath: "/settings/billing" });
  const allowance = await copilotAllowance(tx, tenantId);
  if (mode === "saas" && allowance.remainingMicro !== null && allowance.remainingMicro <= 0) {
    throw new AppError(402, "copilot_limit_reached", "You have used this month's Ask Lumi allowance. It resets next month; chat with your customers is not affected.", {
      limitCredits: allowance.limitCredits, usedMicro: allowance.usedMicro, resetsAt: allowance.resetsAt,
    });
  }
  return allowance;
}

export async function copilotStatus(tx: Tx, tenantId: string, userId: string, mode: "saas" | "selfhosted"): Promise<CopilotStatus> {
  const a = await copilotAccess(tx, tenantId, mode);
  const allowance = await copilotAllowance(tx, tenantId);
  const [s] = await tx<{ id: string; n: number }[]>`
    SELECT s.id, (SELECT count(*)::int FROM copilot_messages m WHERE m.tenant_id = s.tenant_id AND m.session_id = s.id AND m.role = 'user') AS n
    FROM copilot_sessions s WHERE s.tenant_id = ${tenantId} AND s.user_id = ${userId} AND s.status = 'open' ORDER BY s.created_at DESC LIMIT 1`;
  return {
    access: a.allowed ? "allowed" : "locked", reason: a.allowed ? null : a.reason, selfHosted: mode === "selfhosted",
    allowance: mode === "selfhosted" ? { ...allowance, limitCredits: null, remainingMicro: null } : allowance,
    session: s ? { id: s.id, userMessages: s.n, maxUserMessages: MAX_USER_MESSAGES } : null,
  };
}
