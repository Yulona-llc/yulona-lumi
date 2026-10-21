import { allowedNextStages, canTransition, type ConversionStage } from "@yulona/shared";
import type { Tx } from "@yulona/db";
import type { Lead } from "./types";

export const BUILTIN_TOOLS = ["qualify_lead", "collect_contact", "escalate_to_human"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/**
 * The ONLY actions the model is told about (and the executor will accept) per stage (PLAN §3.4).
 * "answer_from_knowledge" is the plain grounded-answer action; the rest are tool names.
 */
export const STAGE_ACTIONS: Readonly<Record<ConversionStage, readonly string[]>> = {
  visitor: ["answer_from_knowledge", "collect_contact", "escalate_to_human"],
  engaged: ["answer_from_knowledge", "collect_contact", "qualify_lead", "escalate_to_human"],
  qualified: ["answer_from_knowledge", "collect_contact", "qualify_lead", "escalate_to_human"],
  booking_offered: ["answer_from_knowledge", "collect_contact", "escalate_to_human"],
  booked: ["answer_from_knowledge", "escalate_to_human"],
  handoff_requested: [],
};

/** Stages a custom tool may run in when its manifest has no `allowedStages`. */
export const DEFAULT_CUSTOM_TOOL_STAGES: readonly ConversionStage[] = ["engaged", "qualified", "booking_offered"];

export class IllegalTransitionError extends Error {}

export interface AiState {
  stage: ConversionStage;
  lead: Lead;
  aiPaused: boolean;
  unansweredTurns: number;
}

export async function getOrCreateState(tx: Tx, tenantId: string, conversationId: string): Promise<AiState> {
  await tx`
    INSERT INTO conversation_ai_state (tenant_id, conversation_id) VALUES (${tenantId}, ${conversationId})
    ON CONFLICT (tenant_id, conversation_id) DO NOTHING`;
  const [row] = await tx<{ stage: ConversionStage; lead: Lead; aiPaused: boolean; unansweredTurns: number }[]>`
    SELECT stage, lead, ai_paused, unanswered_turns FROM conversation_ai_state
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
  return { stage: row!.stage, lead: row!.lead ?? {}, aiPaused: row!.aiPaused, unansweredTurns: row!.unansweredTurns ?? 0 };
}

/** Auditable transition: validated against the table in @yulona/shared, event row appended. */
export async function transitionStage(
  tx: Tx, tenantId: string, conversationId: string, to: ConversionStage, reason: string,
): Promise<ConversionStage> {
  const [row] = await tx<{ stage: ConversionStage }[]>`
    SELECT stage FROM conversation_ai_state
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} FOR UPDATE`;
  if (!row) throw new IllegalTransitionError("no state for conversation");
  if (row.stage === to) return to;
  if (!canTransition(row.stage, to)) {
    throw new IllegalTransitionError(`illegal stage transition ${row.stage} -> ${to} (allowed: ${allowedNextStages(row.stage).join(", ")})`);
  }
  await tx`
    UPDATE conversation_ai_state SET stage = ${to}, updated_at = now(),
      ai_paused = ${to === "handoff_requested"}
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
  await tx`
    INSERT INTO stage_transitions (tenant_id, conversation_id, from_stage, to_stage, reason)
    VALUES (${tenantId}, ${conversationId}, ${row.stage}, ${to}, ${reason})`;
  return to;
}

/** Walk the shortest legal path (e.g. visitor -> engaged -> qualified), recording every hop. */
export async function advanceTo(tx: Tx, tenantId: string, conversationId: string, from: ConversionStage, to: ConversionStage, reason: string): Promise<ConversionStage> {
  const path = shortestPath(from, to);
  if (!path) throw new IllegalTransitionError(`no path ${from} -> ${to}`);
  let cur = from;
  for (const s of path) cur = await transitionStage(tx, tenantId, conversationId, s, reason);
  return cur;
}

export function shortestPath(from: ConversionStage, to: ConversionStage): ConversionStage[] | null {
  if (from === to) return [];
  const q: [ConversionStage, ConversionStage[]][] = [[from, []]];
  const seen = new Set<ConversionStage>([from]);
  while (q.length) {
    const [cur, path] = q.shift()!;
    for (const n of allowedNextStages(cur)) {
      if (seen.has(n)) continue;
      if (n === to) return [...path, n];
      seen.add(n);
      q.push([n, [...path, n]]);
    }
  }
  return null;
}

export async function mergeLead(tx: Tx, tenantId: string, conversationId: string, patch: Lead): Promise<Lead> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== ""));
  const [row] = await tx<{ lead: Lead }[]>`
    UPDATE conversation_ai_state SET lead = lead || ${JSON.stringify(clean)}::text::jsonb, updated_at = now()
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} RETURNING lead`;
  return row!.lead;
}

/**
 * Human returns the conversation to the AI (conversations agent calls this inside its own
 * withTenant transaction when handling "return to AI"). Resumes at `engaged`.
 */
export async function returnConversationToAi(tx: Tx, tenantId: string, conversationId: string): Promise<void> {
  const state = await getOrCreateState(tx, tenantId, conversationId);
  if (state.stage === "handoff_requested") await transitionStage(tx, tenantId, conversationId, "engaged", "returned_to_ai");
  await tx`UPDATE conversation_ai_state SET ai_paused = false, unanswered_turns = 0, updated_at = now()
           WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
}

/** Stage-specific transition helpers for Wave 2 (booking). */
export const markBookingOffered = (tx: Tx, t: string, c: string, from: ConversionStage) => advanceTo(tx, t, c, from, "booking_offered", "booking_offered");
export const markBooked = (tx: Tx, t: string, c: string, from: ConversionStage) => advanceTo(tx, t, c, from, "booked", "booking_confirmed");
