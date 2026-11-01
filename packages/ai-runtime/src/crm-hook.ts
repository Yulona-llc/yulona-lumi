import type { Tx } from "@yulona/db";
import type { ConversionStage } from "@yulona/shared";

/**
 * Called by `transitionStage` after a stage change is persisted (same transaction, so the job and event exist iff the
 * stage change commits). On `qualified`: emits the `lead.qualified` webhook event. On `qualified` and `booked`: when the
 * tenant has a CRM connection, queues `crm.hubspot.sync` once per (conversation, trigger) via the unique sync-log row.
 */
export async function onLeadStage(tx: Tx, tenantId: string, conversationId: string, to: ConversionStage): Promise<void> {
  if (to !== "qualified" && to !== "booked") return;
  const [st] = await tx<{ lead: Record<string, unknown> | null; agentId: string | null; contactId: string | null }[]>`
    SELECT s.lead, c.agent_id, c.contact_id FROM conversations c
    LEFT JOIN conversation_ai_state s ON s.tenant_id = c.tenant_id AND s.conversation_id = c.id
    WHERE c.tenant_id = ${tenantId} AND c.id = ${conversationId}`;
  if (!st) return;
  if (to === "qualified") {
    const lead = st.lead ?? {};
    await tx`SELECT webhook_emit(${tenantId}::uuid, 'lead.qualified', ${tx.json({ conversationId, contactId: st.contactId, agentId: st.agentId, lead } as never)})`;
  }
  const [conn] = await tx`SELECT 1 FROM crm_connections WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
  if (!conn) return;
  const [log] = await tx`
    INSERT INTO crm_sync_log (tenant_id, provider, conversation_id, contact_id, trigger) VALUES (${tenantId}, 'hubspot', ${conversationId}, ${st.contactId}, ${to})
    ON CONFLICT (tenant_id, provider, conversation_id, trigger) WHERE conversation_id IS NOT NULL DO NOTHING RETURNING id`;
  if (log) {
    await tx`INSERT INTO jobs (tenant_id, name, payload, max_attempts) VALUES (${tenantId}, 'crm.hubspot.sync', ${tx.json({ conversationId, trigger: to } as never)}, 6)`;
  }
}
