import { TenantRepository, assertUuid, type Tx } from "@yulona/db";
import type { ContactDto, PrechatConfig, WidgetConfig } from "@yulona/shared";
import type { ContactRow, ConversationRow, MessageRow } from "./dto";

type Sql = Tx;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// ------------------------------------------------------------------ conversations
/** Static SQL fragments (no interpolation; never built from input). */
const convCols = (tx: Sql) => tx`c.id, c.channel, c.status, c.handler, c.assigned_user_id, c.agent_id, c.widget_id,
  c.last_message_at, c.last_message_preview, c.last_customer_message_at, c.created_at, c.resolved_at,
  to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
  ct.id AS contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone, ct.blocked_at AS contact_blocked_at`;

export interface ConversationFilters {
  status?: string;
  handler?: string;
  channel?: string;
  assignedUserId?: string | null | undefined; // null => unassigned
  contactId?: string;
  q?: string;
  cursor?: { ts: string; id: string } | null;
  limit: number;
}

export class ConversationsRepository extends TenantRepository {
  async list(f: ConversationFilters): Promise<ConversationRow[]> {
    const tx = this.tx;
    const q = f.q ? `%${likeEscape(f.q)}%` : null;
    return tx<ConversationRow[]>`
      SELECT ${convCols(tx)}
      FROM conversations c
      JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
      WHERE c.tenant_id = ${this.tenantId}
        ${f.status ? tx`AND c.status = ${f.status}` : tx``}
        ${f.handler ? tx`AND c.handler = ${f.handler}` : tx``}
        ${f.channel ? tx`AND c.channel = ${f.channel}` : tx``}
        ${f.contactId ? tx`AND c.contact_id = ${f.contactId}` : tx``}
        ${f.assignedUserId === null ? tx`AND c.assigned_user_id IS NULL` : f.assignedUserId ? tx`AND c.assigned_user_id = ${f.assignedUserId}` : tx``}
        ${q ? tx`AND (ct.name ILIKE ${q} ESCAPE '\\' OR ct.email ILIKE ${q} ESCAPE '\\' OR ct.phone ILIKE ${q} ESCAPE '\\'
                  OR c.last_message_preview ILIKE ${q} ESCAPE '\\'
                  OR EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
                             AND m.sender_type <> 'system' AND m.content ILIKE ${q} ESCAPE '\\'))` : tx``}
        ${f.cursor ? tx`AND (c.last_message_at, c.id) < (${f.cursor.ts}::timestamptz, ${f.cursor.id}::uuid)` : tx``}
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT ${f.limit + 1}`;
  }

  async get(id: string, lock = false): Promise<ConversationRow | undefined> {
    const tx = this.tx;
    const [row] = await tx<ConversationRow[]>`
      SELECT ${convCols(tx)}
      FROM conversations c
      JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
      WHERE c.tenant_id = ${this.tenantId} AND c.id = ${id}
      ${lock ? tx`FOR UPDATE OF c` : tx``}`;
    return row;
  }

  async create(i: { contactId: string; channel: string; widgetId?: string | null; agentId?: string | null; metadata?: Record<string, unknown> }): Promise<string> {
    const [row] = await this.tx<{ id: string }[]>`
      INSERT INTO conversations (tenant_id, contact_id, channel, widget_id, agent_id, metadata)
      VALUES (${this.tenantId}, ${i.contactId}, ${i.channel}, ${i.widgetId ?? null}, ${i.agentId ?? null}, ${this.tx.json((i.metadata ?? {}) as never)})
      RETURNING id`;
    return row!.id;
  }

  async setState(id: string, s: { status?: string; handler?: string; assignedUserId?: string | null }): Promise<void> {
    const tx = this.tx;
    await tx`
      UPDATE conversations SET
        status = ${s.status ?? tx`status`},
        handler = ${s.handler ?? tx`handler`},
        assigned_user_id = ${s.assignedUserId === undefined ? tx`assigned_user_id` : s.assignedUserId},
        resolved_at = CASE WHEN ${s.status ?? null}::text = 'resolved' THEN now()
                           WHEN ${s.status ?? null}::text IS NOT NULL THEN NULL ELSE resolved_at END,
        updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }

  async hasAny(contactId: string): Promise<boolean> {
    const [r] = await this.tx<{ n: number }[]>`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${this.tenantId} AND contact_id = ${contactId}`;
    return (r?.n ?? 0) > 0;
  }
}

// ------------------------------------------------------------------ messages
const msgSelect = (tx: Sql) => tx`m.id, m.conversation_id, m.sender_type, m.sender_user_id, u.name AS sender_name,
  m.content, m.ui, m.metadata, m.created_at`;

export class MessagesRepository extends TenantRepository {
  async insert(i: {
    conversationId: string;
    senderType: string;
    senderUserId?: string | null;
    content: string;
    ui?: unknown;
    metadata?: Record<string, unknown>;
    clientMessageId?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    const [row] = await this.tx<{ id: string }[]>`
      INSERT INTO messages (tenant_id, conversation_id, sender_type, sender_user_id, content, ui, metadata, client_message_id)
      VALUES (${this.tenantId}, ${i.conversationId}, ${i.senderType}, ${i.senderUserId ?? null}, ${i.content},
              ${i.ui == null ? null : this.tx.json(i.ui as never)}, ${this.tx.json((i.metadata ?? {}) as never)}, ${i.clientMessageId ?? null})
      ON CONFLICT (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
      RETURNING id`;
    if (row) return { id: row.id, created: true };
    const [existing] = await this.tx<{ id: string }[]>`
      SELECT id FROM messages WHERE tenant_id = ${this.tenantId} AND conversation_id = ${i.conversationId} AND client_message_id = ${i.clientMessageId!}`;
    return { id: existing!.id, created: false };
  }

  async get(id: string): Promise<MessageRow | undefined> {
    const tx = this.tx;
    const [row] = await tx<MessageRow[]>`
      SELECT ${msgSelect(tx)} FROM messages m
      LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.sender_user_id
      WHERE m.tenant_id = ${this.tenantId} AND m.id = ${id}`;
    return row;
  }

  /** Newest-first page (limit+1 rows) of one conversation, optionally older than `before` or newer than `after`. */
  async page(conversationId: string, o: { before?: string; after?: string; limit: number; visitorOnly: boolean }): Promise<MessageRow[]> {
    const tx = this.tx;
    const anchor = o.before ?? o.after;
    const vis = o.visitorOnly ? tx`AND m.sender_type IN ('contact','ai','human')` : tx``;
    const cmp = o.before
      ? tx`AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE tenant_id = ${this.tenantId} AND id = ${anchor!} AND conversation_id = ${conversationId})`
      : o.after
        ? tx`AND (m.created_at, m.id) > (SELECT created_at, id FROM messages WHERE tenant_id = ${this.tenantId} AND id = ${anchor!} AND conversation_id = ${conversationId})`
        : tx``;
    return tx<MessageRow[]>`
      SELECT ${msgSelect(tx)} FROM messages m
      LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.sender_user_id
      WHERE m.tenant_id = ${this.tenantId} AND m.conversation_id = ${conversationId} ${vis} ${cmp}
      ORDER BY m.created_at ${o.after ? tx`ASC` : tx`DESC`}, m.id ${o.after ? tx`ASC` : tx`DESC`}
      LIMIT ${o.limit + 1}`;
  }

  async belongsToConversation(id: string, conversationId: string): Promise<boolean> {
    const [r] = await this.tx<{ id: string }[]>`SELECT id FROM messages WHERE tenant_id = ${this.tenantId} AND id = ${id} AND conversation_id = ${conversationId}`;
    return !!r;
  }
}

// ------------------------------------------------------------------ contacts
const contactSelect = (tx: Sql) => tx`ct.id, ct.name, ct.email, ct.phone, ct.custom_attributes, ct.blocked_at, ct.blocked_reason, ct.blocked_by, ct.first_seen_at, ct.last_seen_at, ct.created_at, ct.updated_at,
  (SELECT coalesce(json_agg(json_build_object('channel', i.channel, 'externalId', i.external_id) ORDER BY i.created_at), '[]'::json)
     FROM contact_identities i WHERE i.tenant_id = ct.tenant_id AND i.contact_id = ct.id) AS identities`;

export interface TimelineRow {
  type: "message" | "conversation_started";
  at: Date;
  atText: string;
  itemId: string;
  conversationId: string;
  channel: string;
  senderType: string | null;
  senderUserId: string | null;
  senderName: string | null;
  content: string | null;
  ui: unknown;
  metadata: Record<string, unknown> | null;
}

export class ContactsRepository extends TenantRepository {
  async list(o: { q?: string; cursor?: { ts: string; id: string } | null; limit: number }): Promise<(ContactRow & { cursorTs: string })[]> {
    const tx = this.tx;
    const q = o.q ? `%${likeEscape(o.q)}%` : null;
    return tx`
      SELECT ${contactSelect(tx)}, to_char(ct.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
      FROM contacts ct
      WHERE ct.tenant_id = ${this.tenantId} AND ct.merged_into IS NULL
        ${q ? tx`AND (ct.name ILIKE ${q} ESCAPE '\\' OR ct.email ILIKE ${q} ESCAPE '\\' OR ct.phone ILIKE ${q} ESCAPE '\\')` : tx``}
        ${o.cursor ? tx`AND (ct.created_at, ct.id) < (${o.cursor.ts}::timestamptz, ${o.cursor.id}::uuid)` : tx``}
      ORDER BY ct.created_at DESC, ct.id DESC
      LIMIT ${o.limit + 1}` as unknown as (ContactRow & { cursorTs: string })[];
  }

  async get(id: string, lock = false): Promise<ContactRow | undefined> {
    const tx = this.tx;
    const [row] = await tx<(ContactRow & { mergedInto: string | null })[]>`
      SELECT ${contactSelect(tx)}, ct.merged_into
      FROM contacts ct WHERE ct.tenant_id = ${this.tenantId} AND ct.id = ${id}
      ${lock ? tx`FOR UPDATE OF ct` : tx``}`;
    return row;
  }

  async create(i: { name?: string | null; email?: string | null; phone?: string | null; customAttributes?: Record<string, unknown> }): Promise<string> {
    const [row] = await this.tx<{ id: string }[]>`
      INSERT INTO contacts (tenant_id, name, email, phone, custom_attributes)
      VALUES (${this.tenantId}, ${i.name ?? null}, ${i.email ?? null}, ${i.phone ?? null}, ${this.tx.json((i.customAttributes ?? {}) as never)})
      RETURNING id`;
    return row!.id;
  }

  async update(id: string, p: { name?: string | null; email?: string | null; phone?: string | null; customAttributes?: Record<string, unknown> }): Promise<void> {
    const tx = this.tx;
    await tx`
      UPDATE contacts SET
        name = ${p.name === undefined ? tx`name` : p.name},
        email = ${p.email === undefined ? tx`email` : p.email},
        phone = ${p.phone === undefined ? tx`phone` : p.phone},
        custom_attributes = ${p.customAttributes === undefined ? tx`custom_attributes` : tx.json(p.customAttributes as never)},
        updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }

  /** Fill only empty fields (visitor-provided info never overwrites what agents set). */
  async fillEmpty(id: string, p: { name?: string; email?: string; phone?: string }): Promise<void> {
    await this.tx`
      UPDATE contacts SET name = coalesce(name, ${p.name ?? null}), email = coalesce(email, ${p.email ?? null}),
        phone = coalesce(phone, ${p.phone ?? null}), updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }

  async delete(id: string): Promise<void> {
    await this.tx`DELETE FROM contacts WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }

  async findByIdentity(channel: string, externalId: string): Promise<string | undefined> {
    const [r] = await this.tx<{ contactId: string }[]>`
      SELECT contact_id FROM contact_identities WHERE tenant_id = ${this.tenantId} AND channel = ${channel} AND external_id = ${externalId}`;
    return r?.contactId;
  }
  async addIdentity(contactId: string, channel: string, externalId: string): Promise<void> {
    await this.tx`
      INSERT INTO contact_identities (tenant_id, contact_id, channel, external_id)
      VALUES (${this.tenantId}, ${contactId}, ${channel}, ${externalId}) ON CONFLICT DO NOTHING`;
  }

  /** Block (idempotent: keeps the first reason/actor). `by` null = the AI or a rule. */
  async block(id: string, reason: string | null, by: string | null): Promise<boolean> {
    const r = await this.tx`
      UPDATE contacts SET blocked_at = now(), blocked_reason = ${reason?.slice(0, 500) ?? null}, blocked_by = ${by}, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} AND blocked_at IS NULL`;
    return r.count > 0;
  }
  async unblock(id: string): Promise<boolean> {
    const r = await this.tx`
      UPDATE contacts SET blocked_at = NULL, blocked_reason = NULL, blocked_by = NULL, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} AND blocked_at IS NOT NULL`;
    return r.count > 0;
  }
  async isBlocked(id: string): Promise<boolean> {
    const [r] = await this.tx<{ b: boolean }[]>`SELECT (blocked_at IS NOT NULL) AS b FROM contacts WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r?.b === true;
  }
  /** A contact blocked in the last `hours` hours had a widget session from this IP (shared networks: the window is short on purpose). */
  async blockedRecentlyFromIp(ip: string, hours = 24): Promise<boolean> {
    const [r] = await this.tx<{ n: number }[]>`
      SELECT 1 AS n FROM widget_sessions ws
      JOIN contacts ct ON ct.tenant_id = ws.tenant_id AND ct.id = ws.contact_id
      WHERE ws.tenant_id = ${this.tenantId} AND ws.ip = ${ip} AND ct.blocked_at IS NOT NULL
        AND ct.blocked_at > now() - make_interval(hours => ${hours}::int)
      LIMIT 1`;
    return !!r;
  }

  async timeline(contactId: string, o: { cursor?: { ts: string; id: string } | null; limit: number }): Promise<TimelineRow[]> {
    const tx = this.tx;
    return tx<TimelineRow[]>`
      SELECT * FROM (
        SELECT 'message'::text AS type, m.created_at AS at,
               to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_text, m.id::text AS item_id,
               m.conversation_id, c.channel, m.sender_type, m.sender_user_id, u.name AS sender_name, m.content, m.ui, m.metadata
        FROM messages m
        JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.sender_user_id
        WHERE m.tenant_id = ${this.tenantId} AND c.contact_id = ${contactId}
        UNION ALL
        SELECT 'conversation_started'::text, c.created_at,
               to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), c.id::text,
               c.id, c.channel, NULL, NULL, NULL, NULL, NULL::jsonb, NULL::jsonb
        FROM conversations c WHERE c.tenant_id = ${this.tenantId} AND c.contact_id = ${contactId}
      ) t
      ${o.cursor ? tx`WHERE (t.at, t.item_id) < (${o.cursor.ts}::timestamptz, ${o.cursor.id})` : tx``}
      ORDER BY t.at DESC, t.item_id DESC
      LIMIT ${o.limit + 1}`;
  }

  /** Merge `sourceId` into `primaryId` (both locked by the caller). */
  async merge(primaryId: string, sourceId: string, mergedBy: string): Promise<void> {
    const t = this.tenantId;
    const tx = this.tx;
    await tx`UPDATE conversations SET contact_id = ${primaryId} WHERE tenant_id = ${t} AND contact_id = ${sourceId}`;
    await tx`UPDATE widget_sessions SET contact_id = ${primaryId} WHERE tenant_id = ${t} AND contact_id = ${sourceId}`;
    await tx`UPDATE contact_identities SET contact_id = ${primaryId} WHERE tenant_id = ${t} AND contact_id = ${sourceId}`;
    await tx`
      UPDATE contacts p SET
        name = coalesce(p.name, s.name), email = coalesce(p.email, s.email), phone = coalesce(p.phone, s.phone),
        custom_attributes = s.custom_attributes || p.custom_attributes,
        blocked_at = coalesce(p.blocked_at, s.blocked_at), blocked_reason = CASE WHEN p.blocked_at IS NULL THEN s.blocked_reason ELSE p.blocked_reason END,
        blocked_by = CASE WHEN p.blocked_at IS NULL THEN s.blocked_by ELSE p.blocked_by END,
        first_seen_at = least(p.first_seen_at, s.first_seen_at), last_seen_at = greatest(p.last_seen_at, s.last_seen_at),
        updated_at = now()
      FROM contacts s
      WHERE p.tenant_id = ${t} AND p.id = ${primaryId} AND s.tenant_id = ${t} AND s.id = ${sourceId}`;
    await tx`UPDATE contacts SET merged_into = ${primaryId}, updated_at = now() WHERE tenant_id = ${t} AND id = ${sourceId}`;
    await tx`INSERT INTO contact_merges (tenant_id, primary_contact_id, merged_contact_id, merged_by) VALUES (${t}, ${primaryId}, ${sourceId}, ${mergedBy})`;
  }
}

// ------------------------------------------------------------------ widgets
export interface WidgetRow {
  id: string;
  name: string;
  widgetKey: string;
  agentId: string | null;
  enabled: boolean;
  config: WidgetConfig;
  prechat: PrechatConfig;
  allowedDomains: string[];
  hasTurnstileSecret: boolean;
  avatarVersion: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}
const widgetCols = (tx: Sql) => tx`id, name, widget_key, agent_id, enabled, config, prechat, allowed_domains, (turnstile_secret_enc IS NOT NULL) AS has_turnstile_secret, (SELECT a.etag FROM widget_avatars a WHERE a.tenant_id = widgets.tenant_id AND a.widget_id = widgets.id) AS avatar_version, created_at, updated_at`;

export class WidgetsRepository extends TenantRepository {
  list(): Promise<WidgetRow[]> {
    return this.tx<WidgetRow[]>`SELECT ${widgetCols(this.tx)} FROM widgets WHERE tenant_id = ${this.tenantId} ORDER BY created_at, id`;
  }
  async get(id: string): Promise<WidgetRow | undefined> {
    const [r] = await this.tx<WidgetRow[]>`SELECT ${widgetCols(this.tx)} FROM widgets WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r;
  }
  /** `turnstileSecretEnc` is the already-encrypted envelope (AAD needs the widget id, so create passes a pre-generated `id`). */
  async create(i: { id?: string; name: string; widgetKey: string; agentId?: string | null; enabled?: boolean; config?: unknown; prechat?: unknown; allowedDomains?: string[]; turnstileSecretEnc?: string | null }): Promise<WidgetRow> {
    const [r] = await this.tx<WidgetRow[]>`
      INSERT INTO widgets (id, tenant_id, name, widget_key, agent_id, enabled, config, prechat, allowed_domains, turnstile_secret_enc)
      VALUES (${i.id ?? crypto.randomUUID()}, ${this.tenantId}, ${i.name}, ${i.widgetKey}, ${i.agentId ?? null}, ${i.enabled ?? true},
              ${this.tx.json((i.config ?? {}) as never)}, ${this.tx.json((i.prechat ?? { enabled: false, fields: [] }) as never)},
              ${this.tx.array(i.allowedDomains ?? [])}::text[], ${i.turnstileSecretEnc ?? null})
      RETURNING ${widgetCols(this.tx)}`;
    return r!;
  }
  async update(id: string, p: { name?: string; agentId?: string | null; enabled?: boolean; config?: unknown; prechat?: unknown; allowedDomains?: string[]; turnstileSecretEnc?: string | null }): Promise<WidgetRow | undefined> {
    const tx = this.tx;
    const [r] = await tx<WidgetRow[]>`
      UPDATE widgets SET
        name = ${p.name ?? tx`name`},
        agent_id = ${p.agentId === undefined ? tx`agent_id` : p.agentId},
        enabled = ${p.enabled ?? tx`enabled`},
        config = ${p.config === undefined ? tx`config` : tx.json(p.config as never)},
        prechat = ${p.prechat === undefined ? tx`prechat` : tx.json(p.prechat as never)},
        allowed_domains = ${p.allowedDomains === undefined ? tx`allowed_domains` : tx`${tx.array(p.allowedDomains)}::text[]`},
        turnstile_secret_enc = ${p.turnstileSecretEnc === undefined ? tx`turnstile_secret_enc` : p.turnstileSecretEnc},
        updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}
      RETURNING ${widgetCols(tx)}`;
    return r;
  }
  /** Encrypted Turnstile secret envelope for server-side verification only (never in a DTO). */
  async turnstileSecretEnc(id: string): Promise<string | null> {
    const [r] = await this.tx<{ turnstileSecretEnc: string | null }[]>`SELECT turnstile_secret_enc FROM widgets WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r?.turnstileSecretEnc ?? null;
  }
  async rotateKey(id: string, key: string): Promise<WidgetRow | undefined> {
    const [r] = await this.tx<WidgetRow[]>`
      UPDATE widgets SET widget_key = ${key}, updated_at = now() WHERE tenant_id = ${this.tenantId} AND id = ${id}
      RETURNING ${widgetCols(this.tx)}`;
    return r;
  }
  async setAvatar(id: string, a: { contentType: string; data: Uint8Array; etag: string; userId: string }): Promise<void> {
    await this.tx`
      INSERT INTO widget_avatars (tenant_id, widget_id, content_type, data, etag, updated_by)
      VALUES (${this.tenantId}, ${id}, ${a.contentType}, ${a.data as never}, ${a.etag}, ${a.userId})
      ON CONFLICT (tenant_id, widget_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, etag = EXCLUDED.etag,
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  async removeAvatar(id: string): Promise<boolean> {
    const r = await this.tx`DELETE FROM widget_avatars WHERE tenant_id = ${this.tenantId} AND widget_id = ${id}`;
    return r.count > 0;
  }
  async getAvatar(id: string): Promise<{ contentType: string; data: Uint8Array; etag: string } | undefined> {
    const [r] = await this.tx<{ contentType: string; data: Uint8Array; etag: string }[]>`
      SELECT content_type, data, etag FROM widget_avatars WHERE tenant_id = ${this.tenantId} AND widget_id = ${id}`;
    return r;
  }
  async avatarEtag(id: string): Promise<string | null> {
    const [r] = await this.tx<{ etag: string }[]>`SELECT etag FROM widget_avatars WHERE tenant_id = ${this.tenantId} AND widget_id = ${id}`;
    return r?.etag ?? null;
  }
  async delete(id: string): Promise<boolean> {
    const r = await this.tx`DELETE FROM widgets WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r.count > 0;
  }
}

// ------------------------------------------------------------------ widget sessions
export class WidgetSessionsRepository extends TenantRepository {
  async create(i: { widgetId: string; conversationId: string; contactId: string; origin?: string | null; ip?: string | null; userAgent?: string | null; expiresAt: Date }): Promise<string> {
    const [r] = await this.tx<{ id: string }[]>`
      INSERT INTO widget_sessions (tenant_id, widget_id, conversation_id, contact_id, origin, ip, user_agent, expires_at)
      VALUES (${this.tenantId}, ${i.widgetId}, ${i.conversationId}, ${i.contactId}, ${i.origin?.slice(0, 200) ?? null}, ${i.ip ?? null},
              ${i.userAgent?.slice(0, 256) ?? null}, ${i.expiresAt.toISOString()}::timestamptz)
      RETURNING id`;
    return r!.id;
  }
  async isActive(id: string, widgetId: string, conversationId: string): Promise<boolean> {
    const [r] = await this.tx<{ id: string }[]>`
      SELECT id FROM widget_sessions WHERE tenant_id = ${this.tenantId} AND id = ${id} AND widget_id = ${widgetId}
        AND conversation_id = ${conversationId} AND revoked_at IS NULL AND expires_at > now()`;
    return !!r;
  }
  /** Revoke every active session of a conversation (abuse block, conversation closed by the AI). */
  async revokeForConversation(conversationId: string): Promise<void> {
    await this.tx`UPDATE widget_sessions SET revoked_at = now() WHERE tenant_id = ${this.tenantId} AND conversation_id = ${conversationId} AND revoked_at IS NULL`;
  }
  async revokeForContact(contactId: string): Promise<void> {
    await this.tx`UPDATE widget_sessions SET revoked_at = now() WHERE tenant_id = ${this.tenantId} AND contact_id = ${contactId} AND revoked_at IS NULL`;
  }
  async extend(id: string, expiresAt: Date): Promise<void> {
    await this.tx`UPDATE widget_sessions SET expires_at = ${expiresAt.toISOString()}::timestamptz WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }
}

export { assertUuid };
export type { ContactDto };

// ------------------------------------------------------------------ public widget key resolution
import type { Db } from "@yulona/db";
export interface ResolvedWidget {
  widgetId: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  allowedDomains: string[];
  config: WidgetConfig;
  prechat: PrechatConfig;
  agentId: string | null;
  tenantStatus: string;
}
/**
 * Pre-auth lookup: the only cross-tenant read of `widgets`, through the narrow SECURITY DEFINER function
 * `widget_resolve` (returns just what the public API needs). Everything after this runs under withTenant.
 */
export async function resolveWidget(db: Db, key: string): Promise<ResolvedWidget | undefined> {
  const [r] = await db<ResolvedWidget[]>`SELECT * FROM widget_resolve(${key})`;
  return r;
}
