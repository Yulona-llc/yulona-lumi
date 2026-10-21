/**
 * The ONLY file that touches tables owned by the `conversations` agent
 * (conversations, messages, contacts). Adjust column names here if their schema differs.
 */
import type { Tx } from "@yulona/db";
import type { WidgetUISchema } from "@yulona/shared";
import type { Lead, TurnMessage } from "./types";

export interface ConversationCtx {
  id: string;
  agentId: string | null;
  channel: string;
  status: string;
  /** 'ai' | 'human' (human = a person took over; AI must stay silent) */
  handler: string;
  contactId: string | null;
}
export interface InboundMessage {
  id: string;
  senderType: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export async function loadConversation(tx: Tx, tenantId: string, conversationId: string): Promise<ConversationCtx | null> {
  const [r] = await tx<ConversationCtx[]>`
    SELECT id, agent_id, channel, status, handler, contact_id FROM conversations
    WHERE tenant_id = ${tenantId} AND id = ${conversationId}`;
  return r ?? null;
}

export async function loadMessage(tx: Tx, tenantId: string, conversationId: string, messageId: string): Promise<InboundMessage | null> {
  const [r] = await tx<InboundMessage[]>`
    SELECT id, sender_type, content, metadata, created_at FROM messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND id = ${messageId}`;
  return r ?? null;
}

/** Last N customer/AI/human messages before `messageId` (oldest first); notes and system rows excluded. */
export async function loadHistory(tx: Tx, tenantId: string, conversationId: string, beforeCreatedAt: Date, limit = 12): Promise<TurnMessage[]> {
  const rows = await tx<{ senderType: string; content: string }[]>`
    SELECT sender_type, content FROM messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
      AND sender_type IN ('contact','ai','human') AND created_at < ${beforeCreatedAt}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.reverse().map((r) => ({ role: r.senderType === "contact" ? "user" : "assistant", content: r.content }) as TurnMessage);
}

export async function lastCustomerMessageAt(tx: Tx, tenantId: string, conversationId: string): Promise<Date | null> {
  const [r] = await tx<{ at: Date | null }[]>`
    SELECT max(created_at) AS at FROM messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND sender_type = 'contact'`;
  return r?.at ?? null;
}

export async function hasReplyTo(tx: Tx, tenantId: string, conversationId: string, messageId: string): Promise<boolean> {
  const [r] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
      AND sender_type IN ('ai','system') AND metadata->>'inReplyTo' = ${messageId}`;
  return (r?.n ?? 0) > 0;
}

export async function insertAiMessage(
  tx: Tx, tenantId: string, conversationId: string,
  m: { text: string; ui: WidgetUISchema; senderType?: "ai" | "system"; metadata: Record<string, unknown> },
): Promise<string> {
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO messages (tenant_id, conversation_id, sender_type, content, ui, metadata)
    VALUES (${tenantId}, ${conversationId}, ${m.senderType ?? "ai"}, ${m.text}, ${JSON.stringify(m.ui)}::text::jsonb, ${JSON.stringify(m.metadata)}::text::jsonb)
    RETURNING id`;
  await tx`
    UPDATE conversations SET updated_at = now(), last_message_at = now(), last_message_preview = ${m.text.slice(0, 140)}
    WHERE tenant_id = ${tenantId} AND id = ${conversationId}`;
  return r!.id;
}

export async function setPendingHuman(tx: Tx, tenantId: string, conversationId: string): Promise<void> {
  await tx`UPDATE conversations SET status = 'pending_human', updated_at = now()
           WHERE tenant_id = ${tenantId} AND id = ${conversationId}`;
}

export async function updateContact(tx: Tx, tenantId: string, contactId: string, patch: Lead): Promise<void> {
  const sets: Record<string, string> = {};
  if (patch.name) sets.name = patch.name;
  if (patch.email) sets.email = patch.email;
  if (patch.phone) sets.phone = patch.phone;
  if (!Object.keys(sets).length) return;
  try {
    await tx.savepoint(async (sp) => {
      await sp`UPDATE contacts SET ${sp(sets)}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${contactId}`;
    });
  } catch {
    // e.g. unique-email conflict with another contact; the lead data still lives in conversation_ai_state
  }
}
