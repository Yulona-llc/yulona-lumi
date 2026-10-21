import { advanceTo, getOrCreateState } from "@yulona/ai-runtime";
import type { Tx } from "@yulona/db";

export const CUSTOMER_FAILURE_MESSAGE = "I couldn't complete that just now, so I've asked a teammate to follow up with you shortly.";

/**
 * Raise a `system_failure` handoff for an AI-handled conversation (calendar timeout etc.), exactly like the
 * AI runtime does: handoffs row (the 0400 trigger routes/notifies), stage -> handoff_requested (AI paused),
 * conversation -> pending_human, plus a customer-facing message. No-op (returns null) unless the conversation is
 * open and AI-handled.
 */
export async function raiseSystemFailureHandoff(
  tx: Tx, tenantId: string, conversationId: string, reason: string, context: Record<string, unknown> = {},
): Promise<string | null> {
  const [conv] = await tx<{ status: string; handler: string }[]>`
    SELECT status, handler FROM conversations WHERE tenant_id = ${tenantId} AND id = ${conversationId} FOR UPDATE`;
  if (!conv || conv.status !== "open" || conv.handler !== "ai") return null;
  const state = await getOrCreateState(tx, tenantId, conversationId);
  const [h] = await tx<{ id: string }[]>`
    INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary, context)
    VALUES (${tenantId}, ${conversationId}, 'system_failure', ${reason.slice(0, 500)}, ${reason.slice(0, 500)}, ${tx.json({ ...context, stage: state.stage } as never)})
    RETURNING id`;
  if (state.stage !== "handoff_requested") {
    await advanceTo(tx, tenantId, conversationId, state.stage, "handoff_requested", "handoff:system_failure");
  }
  await tx`UPDATE conversation_ai_state SET last_handoff_type = 'system_failure', ai_paused = true, updated_at = now()
           WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
  await tx`UPDATE conversations SET status = 'pending_human', updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${conversationId}`;
  await tx`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, metadata)
           VALUES (${tenantId}, ${conversationId}, 'ai', ${CUSTOMER_FAILURE_MESSAGE}, ${tx.json({ event: "system_failure", handoffId: h!.id } as never)})`;
  return h!.id;
}
