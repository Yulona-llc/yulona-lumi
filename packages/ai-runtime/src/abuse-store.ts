import { AuditLogRepository, type Tx } from "@yulona/db";
import { WIDGET_UI_SCHEMA_VERSION } from "@yulona/shared";
import { insertAiMessage } from "./conversation-store";
import type { AbuseContext } from "./abuse";

export async function isContactBlocked(tx: Tx, tenantId: string, contactId: string | null): Promise<boolean> {
  if (!contactId) return false;
  const [r] = await tx<{ b: boolean }[]>`SELECT (blocked_at IS NOT NULL) AS b FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId}`;
  return r?.b === true;
}

/** Strikes so far and the customer's message rate (relative to the message being answered). */
export async function loadAbuseContext(tx: Tx, tenantId: string, conversationId: string, at: Date): Promise<AbuseContext> {
  const [s] = await tx<{ strikes: number }[]>`
    SELECT abuse_strikes AS strikes FROM conversation_ai_state WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
  const [n] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND sender_type = 'contact'
      AND created_at <= ${at} AND created_at > ${at}::timestamptz - interval '60 seconds'`;
  return { strikes: s?.strikes ?? 0, messagesLastMinute: n?.n ?? 0 };
}

/**
 * The visitor reached the strike limit. Called in the SAME transaction that stored the farewell message, so the visitor
 * always sees the farewell first and everything below commits (or none of it does): close the conversation, raise the
 * abuse handoff (which notifies owners and admins once), block the contact, revoke the widget session(s), audit-log.
 */
export async function applyAbuseBlock(
  tx: Tx, tenantId: string, conversationId: string,
  o: { contactId: string | null; reason: string; source: "rule" | "model"; kind: string; strikes: number; agentId?: string; messageId: string; summary: string },
): Promise<void> {
  await tx`UPDATE conversations SET status = 'resolved', resolved_at = now(), updated_at = now()
           WHERE tenant_id = ${tenantId} AND id = ${conversationId}`;
  await tx`UPDATE conversation_ai_state SET abuse_strikes = ${o.strikes}, ai_paused = true, last_handoff_type = 'abuse', updated_at = now()
           WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
  await tx`
    INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary, context)
    VALUES (${tenantId}, ${conversationId}, 'abuse', ${`Blocked for abuse: ${o.reason}`.slice(0, 500)}, ${o.summary.slice(0, 1200)},
            ${JSON.stringify({ messageId: o.messageId, source: o.source, kind: o.kind, strikes: o.strikes, agentId: o.agentId })}::text::jsonb)`;
  if (o.contactId) {
    await tx`
      UPDATE contacts SET blocked_at = now(), blocked_reason = ${o.reason.slice(0, 500)}, blocked_by = NULL, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${o.contactId} AND blocked_at IS NULL`;
    await tx`UPDATE widget_sessions SET revoked_at = now() WHERE tenant_id = ${tenantId} AND contact_id = ${o.contactId} AND revoked_at IS NULL`;
  } else {
    await tx`UPDATE widget_sessions SET revoked_at = now() WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND revoked_at IS NULL`;
  }
  await insertAiMessage(tx, tenantId, conversationId, {
    text: "Conversation closed and visitor blocked for abuse", ui: { version: WIDGET_UI_SCHEMA_VERSION, components: [] }, senderType: "system",
    metadata: { event: "abuse_blocked", reason: o.reason, source: o.source },
  });
  await new AuditLogRepository(tx, tenantId).record({
    actorUserId: null, action: "contact.block", resourceType: "contact", resourceId: o.contactId ?? undefined,
    metadata: { conversationId, reason: o.reason, source: o.source, kind: o.kind, strikes: o.strikes, by: "ai" },
  });
}
