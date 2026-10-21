import { z } from "zod";
import type { Db } from "@yulona/db";
import { FatalJobError, type JobHandlers } from "@yulona/queue";
import type { ChannelType, WidgetUISchema } from "@yulona/shared";
import { ChannelSendError } from "./http";
import type { ChannelRegistry } from "./registry";
import type { ChannelCredentials } from "./types";

export const credentialAad = (tenantId: string, connectionId: string) => `${tenantId}:${connectionId}`;

const payloadSchema = z.object({ tenantId: z.string().uuid(), messageId: z.string().uuid() });

export interface ChannelJobDeps {
  db: Db;
  registry: ChannelRegistry;
  /** Decrypts a stored credential envelope (apps/api `decryptCredentials` bound to ENCRYPTION_KEY). */
  decrypt: (envelope: string, aad: string) => ChannelCredentials;
}

interface MsgRow {
  senderType: string;
  content: string;
  ui: WidgetUISchema | null;
  conversationId: string;
  contactId: string;
  channel: ChannelType;
  connectionId: string | null;
  lastCustomerMessageAt: Date | null;
  externalContactId: string | null;
}

/**
 * Worker job `channel.send` (payload `{ tenantId, messageId }`): delivers one AI/human reply to the
 * customer's channel. Enqueued by the `messages_enqueue_channel_send` DB trigger. Idempotent through
 * `channel_deliveries` (unique per message). Transient errors retry via the queue backoff; permanent
 * errors (24h window closed, bad credentials, rejected) are recorded, surfaced as a `system` message
 * in the conversation, and do not dead-letter.
 */
export function createChannelJobHandlers(deps: ChannelJobDeps): JobHandlers {
  return {
    "channel.send": async (raw, ctx) => {
      const parsed = payloadSchema.safeParse(raw);
      if (!parsed.success) throw new FatalJobError("invalid channel.send payload");
      const { messageId, tenantId } = parsed.data;

      const prep = await ctx.withTenant(async (tx) => {
        const [done] = await tx`SELECT 1 FROM channel_deliveries WHERE tenant_id = ${tenantId} AND message_id = ${messageId}`;
        if (done) return null;
        const [m] = await tx<MsgRow[]>`
          SELECT m.sender_type, m.content, m.ui, m.conversation_id, c.contact_id, c.channel,
                 c.channel_connection_id AS connection_id, c.last_customer_message_at,
                 c.metadata->>'externalContactId' AS external_contact_id
          FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
          WHERE m.tenant_id = ${tenantId} AND m.id = ${messageId}`;
        if (!m || m.channel === "widget" || (m.senderType !== "ai" && m.senderType !== "human")) return null;
        let external = m.externalContactId;
        if (!external) {
          const [i] = await tx<{ externalId: string }[]>`
            SELECT external_id FROM contact_identities WHERE tenant_id = ${tenantId} AND contact_id = ${m.contactId} AND channel = ${m.channel}
            ORDER BY created_at DESC LIMIT 1`;
          external = i?.externalId ?? null;
        }
        const [conn] = m.connectionId
          ? await tx<{ status: string; credentialsEncrypted: string }[]>`
              SELECT status, credentials_encrypted FROM channel_connections WHERE tenant_id = ${tenantId} AND id = ${m.connectionId}`
          : [];
        return { m, external, conn };
      });
      if (!prep) return;
      const { m, external, conn } = prep;

      const fail = async (code: string, message: string) => {
        await ctx.withTenant(async (tx) => {
          const [ins] = await tx<{ id: string }[]>`
            INSERT INTO channel_deliveries (tenant_id, message_id, conversation_id, connection_id, channel, status, error, attempts)
            VALUES (${tenantId}, ${messageId}, ${m.conversationId}, ${m.connectionId}, ${m.channel}, 'failed', ${message.slice(0, 500)}, ${ctx.job.attempts})
            ON CONFLICT (message_id) DO NOTHING RETURNING id`;
          if (!ins) return;
          await tx`
            INSERT INTO messages (tenant_id, conversation_id, sender_type, content, metadata)
            VALUES (${tenantId}, ${m.conversationId}, 'system', ${`Message not delivered on ${m.channel}: ${message.slice(0, 200)}`},
                    ${tx.json({ event: "delivery_failed", messageId, code } as never)})`;
          if (code === "bad_credentials" && m.connectionId) {
            await tx`UPDATE channel_connections SET status = 'error', last_health_ok = false, last_health_error = ${message.slice(0, 300)}, last_health_at = now(), updated_at = now()
                     WHERE tenant_id = ${tenantId} AND id = ${m.connectionId}`;
          }
        });
      };

      if (!conn || !m.connectionId) return fail("no_connection", "channel connection no longer exists");
      if (conn.status === "disabled") return fail("disabled", "channel connection is disabled");
      if (!external) return fail("invalid_destination", "customer has no identity on this channel");
      const adapter = deps.registry.get(m.channel);
      if (!adapter) return fail("no_adapter", `no adapter for ${m.channel}`);

      let credentials: ChannelCredentials;
      try {
        credentials = deps.decrypt(conn.credentialsEncrypted, credentialAad(tenantId, m.connectionId));
      } catch {
        return fail("bad_credentials", "stored credentials cannot be decrypted");
      }

      try {
        const res = await adapter.send(
          { conversationId: m.conversationId, externalContactId: external, text: m.content, ui: m.ui, lastCustomerMessageAt: m.lastCustomerMessageAt },
          credentials,
        );
        await ctx.withTenant(async (tx) => {
          await tx`
            INSERT INTO channel_deliveries (tenant_id, message_id, conversation_id, connection_id, channel, status, external_message_id, used_template, attempts)
            VALUES (${tenantId}, ${messageId}, ${m.conversationId}, ${m.connectionId}, ${m.channel}, 'sent', ${res.externalMessageId ?? null}, ${res.usedTemplate ?? false}, ${ctx.job.attempts})
            ON CONFLICT (message_id) DO NOTHING`;
        });
      } catch (e) {
        if (e instanceof ChannelSendError) {
          if (e.retryable && ctx.job.attempts < ctx.job.maxAttempts) throw e;
          return fail(e.code, e.message);
        }
        throw e;
      }
    },
  };
}
