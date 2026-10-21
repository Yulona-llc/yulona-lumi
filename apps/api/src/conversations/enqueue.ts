import { enqueue } from "@yulona/queue";
import type { Tx } from "@yulona/db";

/** Enqueue the AI reply job atomically with the contact message insert (same transaction). */
export function enqueueAiRespond(tx: Tx, p: { tenantId: string; conversationId: string; messageId: string }): Promise<string> {
  return enqueue(tx, { name: "ai.respond", tenantId: p.tenantId, payload: p });
}
