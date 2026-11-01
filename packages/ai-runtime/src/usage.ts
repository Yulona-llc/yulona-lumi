import type { Tx } from "@yulona/db";

export type UsageSource = "turn" | "sandbox" | "builder" | "tool_test" | "copilot" | "onboarding";

export interface UsageDelta {
  promptTokens?: number;
  completionTokens?: number;
  requests?: number;
  /** event attribution (ai_usage_events) */
  agentId?: string | null;
  conversationId?: string | null;
  source?: UsageSource;
  model?: string | null;
  profileId?: string | null;
  /**
   * Charge credits (monthly allowance first, then top-ups). Default: charge unless DEPLOYMENT_MODE=selfhosted
   * (self-hosted still records the event with its computed cost, but never charges or gates).
   */
  charge?: boolean;
}

export const MICRO_PER_CREDIT = 1_000_000;

export interface ModelRate {
  inputMicroPer1k: number;
  outputMicroPer1k: number;
}

/** Cost in micro-credits, rounded up: ceil((prompt * in + completion * out) / 1000). */
export function computeCostMicro(rate: ModelRate, promptTokens: number, completionTokens: number): number {
  const total = BigInt(Math.max(0, Math.round(promptTokens))) * BigInt(Math.round(rate.inputMicroPer1k))
    + BigInt(Math.max(0, Math.round(completionTokens))) * BigInt(Math.round(rate.outputMicroPer1k));
  return Number((total + 999n) / 1000n);
}

/** Rate row for the model, else the `*` default (disabled rows are ignored). */
export async function getModelRate(tx: Tx, model: string | null | undefined): Promise<ModelRate> {
  const [r] = await tx<{ inputMicroPer1k: string; outputMicroPer1k: string }[]>`
    SELECT input_micro_per_1k, output_micro_per_1k FROM llm_model_rates
    WHERE enabled AND model IN (${model ?? "*"}, '*') ORDER BY (model = '*') LIMIT 1`;
  return { inputMicroPer1k: Number(r?.inputMicroPer1k ?? 0), outputMicroPer1k: Number(r?.outputMicroPer1k ?? 0) };
}

export interface CreditsRow {
  tenantId: string;
  period: string;
  allowanceMicro: string | null;
  usedMicro: string;
  topupMicro: string;
  topupUsedMicro: string;
}

const shouldCharge = (d: UsageDelta) => d.charge ?? process.env.DEPLOYMENT_MODE !== "selfhosted";

/**
 * Record one LLM call/turn: an `ai_usage_events` row (with its credit cost), the per-day `ai_usage` counters, and
 * (when charging) atomically consume credits. Runs inside the caller's tenant transaction. Credit bookkeeping runs in
 * a savepoint so a failure there can never lose the reply that is being persisted.
 */
export async function addUsage(tx: Tx, tenantId: string, d: UsageDelta): Promise<{ creditsMicro: number }> {
  const prompt = Math.max(0, Math.round(d.promptTokens ?? 0));
  const completion = Math.max(0, Math.round(d.completionTokens ?? 0));
  const rows: [string, number][] = [
    ["llm_prompt_tokens", prompt],
    ["llm_completion_tokens", completion],
    ["llm_requests", d.requests ?? 0],
  ];
  for (const [kind, amount] of rows) {
    if (amount <= 0) continue;
    await tx`
      INSERT INTO ai_usage (tenant_id, day, kind, amount) VALUES (${tenantId}, (now() AT TIME ZONE 'UTC')::date, ${kind}, ${Math.round(amount)})
      ON CONFLICT (tenant_id, day, kind) DO UPDATE SET amount = ai_usage.amount + EXCLUDED.amount`;
  }
  if (prompt + completion <= 0) return { creditsMicro: 0 };
  const creditsMicro = computeCostMicro(await getModelRate(tx, d.model), prompt, completion);
  await tx`
    INSERT INTO ai_usage_events (tenant_id, agent_id, conversation_id, source, model, profile_id, prompt_tokens, completion_tokens, credits_micro)
    VALUES (${tenantId}, ${d.agentId ?? null}, ${d.conversationId ?? null}, ${d.source ?? "turn"}, ${d.model ?? null}, ${d.profileId ?? null},
            ${prompt}, ${completion}, ${creditsMicro})`;
  if (shouldCharge(d) && creditsMicro > 0) {
    try {
      await tx.savepoint(async (sp) => { await sp`SELECT consume_credits(${tenantId}::uuid, ${creditsMicro}::bigint)`; });
    } catch {
      // credit bookkeeping must not block the reply; the event row above is the source of truth for reconciliation
    }
  }
  return { creditsMicro };
}

/** Remaining micro-credits for the gate (null = unlimited). Also fires the "exhausted" notice once per period. */
export async function creditsRemaining(tx: Tx, tenantId: string): Promise<number | null> {
  const [r] = await tx<{ creditsGate: string | null }[]>`SELECT credits_gate(${tenantId}::uuid)`;
  return r?.creditsGate == null ? null : Number(r.creditsGate);
}

export class CreditsExhaustedError extends Error {
  constructor(public readonly remainingMicro: number) {
    super("AI credits exhausted");
  }
}
