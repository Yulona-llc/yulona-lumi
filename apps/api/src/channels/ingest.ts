import { createHash } from "node:crypto";
import type { Tx } from "@yulona/db";
import { ContactsRepository, MessagesRepository } from "../conversations/repos";
import { enqueueAiRespond } from "../conversations/enqueue";
import type { InboundMessage } from "@yulona/channels";

export interface IngestConnection {
  id: string;
  channel: InboundMessage["channel"];
  agentId: string | null;
}
export interface IngestResult {
  processed: number;
  duplicates: number;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Record (connection, event id); false when it was already seen (replay / provider retry). */
async function firstDelivery(tx: Tx, tenantId: string, connectionId: string, eventId: string): Promise<boolean> {
  const r = await tx`
    INSERT INTO channel_webhook_events (tenant_id, connection_id, event_id)
    VALUES (${tenantId}, ${connectionId}, ${eventId.slice(0, 300)})
    ON CONFLICT (connection_id, event_id) DO NOTHING RETURNING id`;
  return r.length > 0;
}

/**
 * Contact identity resolution: identity (channel, external id) -> contact; WhatsApp numbers are also
 * matched against existing contacts by phone digits; otherwise a new contact is created and merge
 * suggestions (same email/phone/name) are recorded for a human to confirm.
 */
async function resolveContact(tx: Tx, tenantId: string, m: InboundMessage): Promise<{ contactId: string; created: boolean }> {
  const contacts = new ContactsRepository(tx, tenantId);
  const existing = await contacts.findByIdentity(m.channel, m.externalContactId);
  if (existing) {
    if (m.displayName) await contacts.fillEmpty(existing, { name: m.displayName.slice(0, 200) });
    return { contactId: existing, created: false };
  }
  if (m.phone && digits(m.phone).length >= 7) {
    const [byPhone] = await tx<{ id: string }[]>`
      SELECT id FROM contacts WHERE tenant_id = ${tenantId} AND merged_into IS NULL
        AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = ${digits(m.phone)}
      ORDER BY created_at LIMIT 1`;
    if (byPhone) {
      await contacts.addIdentity(byPhone.id, m.channel, m.externalContactId);
      if (m.displayName) await contacts.fillEmpty(byPhone.id, { name: m.displayName.slice(0, 200) });
      return { contactId: byPhone.id, created: false };
    }
  }
  const id = await contacts.create({ name: m.displayName?.slice(0, 200) ?? null, phone: m.phone ?? null });
  await contacts.addIdentity(id, m.channel, m.externalContactId);
  await suggestMerges(tx, tenantId, id);
  return { contactId: id, created: true };
}

/** Flag likely duplicates of `contactId` (same email / phone digits / name). Humans confirm via the contacts merge API. */
export async function suggestMerges(tx: Tx, tenantId: string, contactId: string): Promise<number> {
  const rows = await tx<{ id: string; reason: string }[]>`
    WITH me AS (SELECT id, lower(email) AS email, regexp_replace(coalesce(phone, ''), '\\D', '', 'g') AS ph, lower(trim(name)) AS nm
                FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId})
    SELECT DISTINCT ON (c.id) c.id,
      CASE WHEN me.email IS NOT NULL AND lower(c.email) = me.email THEN 'same_email'
           WHEN length(me.ph) >= 7 AND regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') = me.ph THEN 'same_phone'
           ELSE 'same_name' END AS reason
    FROM contacts c, me
    WHERE c.tenant_id = ${tenantId} AND c.id <> me.id AND c.merged_into IS NULL AND (
      (me.email IS NOT NULL AND lower(c.email) = me.email)
      OR (length(me.ph) >= 7 AND regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') = me.ph)
      OR (me.nm IS NOT NULL AND length(me.nm) >= 3 AND lower(trim(c.name)) = me.nm))
    LIMIT 5`;
  for (const r of rows) {
    // primary = the older contact (the one that already exists); the new one is the merge candidate
    await tx`
      INSERT INTO contact_merge_suggestions (tenant_id, primary_contact_id, other_contact_id, reason)
      VALUES (${tenantId}, ${r.id}, ${contactId}, ${r.reason})
      ON CONFLICT (tenant_id, primary_contact_id, other_contact_id) DO NOTHING`;
  }
  return rows.length;
}

async function openConversation(tx: Tx, tenantId: string, conn: IngestConnection, contactId: string, externalContactId: string) {
  const [existing] = await tx<{ id: string; status: string; handler: string }[]>`
    SELECT id, status, handler FROM conversations
    WHERE tenant_id = ${tenantId} AND contact_id = ${contactId} AND channel = ${conn.channel}
      AND channel_connection_id = ${conn.id} AND status <> 'resolved'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
  if (existing) return existing;
  const [row] = await tx<{ id: string; status: string; handler: string }[]>`
    INSERT INTO conversations (tenant_id, contact_id, channel, channel_connection_id, agent_id, metadata)
    VALUES (${tenantId}, ${contactId}, ${conn.channel}, ${conn.id}, ${conn.agentId}, ${tx.json({ externalContactId } as never)})
    RETURNING id, status, handler`;
  return row!;
}

/**
 * Ingest verified, parsed inbound messages inside a tenant transaction: replay protection ->
 * identity resolution -> conversation (reuse the open one, else start) -> message -> `ai.respond`
 * when the conversation is AI-handled. DB triggers publish the realtime events.
 */
export async function ingestInbound(tx: Tx, tenantId: string, conn: IngestConnection, msgs: InboundMessage[]): Promise<IngestResult> {
  const result: IngestResult = { processed: 0, duplicates: 0 };
  await tx`DELETE FROM channel_webhook_events WHERE tenant_id = ${tenantId} AND connection_id = ${conn.id} AND received_at < now() - interval '7 days'`;
  const messages = new MessagesRepository(tx, tenantId);
  for (const m of msgs) {
    const eventId = m.externalMessageId ?? createHash("sha256").update(`${m.externalContactId}|${m.receivedAt.toISOString()}|${m.text}`).digest("hex");
    if (!(await firstDelivery(tx, tenantId, conn.id, eventId))) {
      result.duplicates++;
      continue;
    }
    // Serialize first-contact races for the same customer so we never create two contacts.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}|${conn.channel}|${m.externalContactId}`}, 0))`;
    const { contactId } = await resolveContact(tx, tenantId, m);
    // abuse: a blocked contact's messages are dropped (no conversation, no reply) until a person unblocks them
    const [blk] = await tx<{ b: boolean }[]>`SELECT (blocked_at IS NOT NULL) AS b FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId}`;
    if (blk?.b) {
      result.processed++;
      continue;
    }
    const conv = await openConversation(tx, tenantId, conn, contactId, m.externalContactId);
    const { id: messageId } = await messages.insert({
      conversationId: conv.id, senderType: "contact", content: m.text || "[empty message]",
      metadata: { channel: m.channel, externalMessageId: m.externalMessageId ?? null },
    });
    // Also enqueued while a person is pending: the runtime skips it unless the customer sent the resume keyword.
    if (conv.status !== "resolved") await enqueueAiRespond(tx, { tenantId, conversationId: conv.id, messageId });
    result.processed++;
  }
  return result;
}
