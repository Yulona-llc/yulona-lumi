import type { Tx } from "@yulona/db";

/** "Typical message" used until a workspace has enough history: ~6k tokens in, ~0.6k out (after the turn cost cuts). */
export const TYPICAL_PROMPT_TOKENS = 6000;
export const TYPICAL_COMPLETION_TOKENS = 600;
/** Answered messages (source=turn events) needed in the window before the workspace's own average is used. */
export const MIN_SAMPLE = 10;
export const WINDOW_DAYS = 30;

export interface MessageEstimate {
  /** Average credits one answered message costs, in micro-credits. */
  creditsPerMessageMicro: number;
  basis: "usage" | "typical";
}

/** Typical-message cost at a rate (micro per 1k tokens), rounded up like the metering does. */
export function typicalMessageMicro(rate: { inputMicroPer1k: number; outputMicroPer1k: number }): number {
  return Math.ceil((TYPICAL_PROMPT_TOKENS * rate.inputMicroPer1k + TYPICAL_COMPLETION_TOKENS * rate.outputMicroPer1k) / 1000);
}

/** Whole messages a micro-credit balance covers at the given cost per message. */
export function messagesLeft(remainingMicro: number, perMessageMicro: number): number {
  return perMessageMicro > 0 ? Math.max(0, Math.floor(remainingMicro / perMessageMicro)) : 0;
}

/**
 * Rolling average credits per answered message (one `ai_usage_events` row per turn) over the last 30 days; falls back
 * to the typical message at the default `*` rate when the workspace has fewer than MIN_SAMPLE answered messages.
 */
export async function loadMessageEstimate(tx: Tx, tenantId: string): Promise<MessageEstimate> {
  const [s] = await tx<{ n: string; avg: string | null }[]>`
    SELECT count(*)::bigint AS n, avg(credits_micro)::numeric(20,2) AS avg FROM ai_usage_events
    WHERE tenant_id = ${tenantId} AND source = 'turn' AND credits_micro > 0 AND day >= (now() AT TIME ZONE 'UTC')::date - ${WINDOW_DAYS}::int`;
  const n = Number(s?.n ?? 0), avg = Number(s?.avg ?? 0);
  if (n >= MIN_SAMPLE && avg > 0) return { creditsPerMessageMicro: Math.ceil(avg), basis: "usage" };
  const [r] = await tx<{ inputMicroPer1k: string; outputMicroPer1k: string }[]>`
    SELECT input_micro_per_1k, output_micro_per_1k FROM llm_model_rates WHERE model = '*' AND enabled`;
  return {
    creditsPerMessageMicro: Math.max(1, typicalMessageMicro({ inputMicroPer1k: Number(r?.inputMicroPer1k ?? 250_000), outputMicroPer1k: Number(r?.outputMicroPer1k ?? 1_000_000) })),
    basis: "typical",
  };
}
