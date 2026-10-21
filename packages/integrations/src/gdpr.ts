import { assertUuid, type Tx } from "@yulona/db";
import { FatalJobError, type JobContext, type JobHandler } from "@yulona/queue";
import type { StorageProvider } from "@yulona/providers";

export const GDPR_EXPORT_JOB = "gdpr.export";
export const GDPR_ERASE_JOB = "gdpr.erase";
/** Export files (and their download links) stop working after this long. */
export const EXPORT_TTL_DAYS = 7;
const ROW_CAP = 100_000;
/** Tables owned by other waves; included only when present and carrying the expected columns. */
const OPTIONAL_CONTACT_TABLES = ["tickets", "bookings", "transactions"] as const;

export const exportKey = (tenantId: string, requestId: string) => `gdpr/${tenantId}/${requestId}.json`;

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const camelKeys = (o: unknown): unknown =>
  o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v])) : o;

async function hasColumn(tx: Tx, table: string, col: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${col}) AS ok`;
  return !!r?.ok;
}

/** Rows of an optional table as JSON (table name comes from a constant allowlist, never from input). */
async function optionalRows(tx: Tx, table: (typeof OPTIONAL_CONTACT_TABLES)[number], tenantId: string, contactIds: string[] | null) {
  if (!(await hasColumn(tx, table, "tenant_id"))) return null;
  if (contactIds) {
    if (!(await hasColumn(tx, table, "contact_id"))) return null;
    const rows = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id = $1 AND contact_id = ANY($2::uuid[]) LIMIT ${ROW_CAP}`, [tenantId, contactIds] as never);
    return [...rows].map((r) => camelKeys((r as unknown as { row: unknown }).row));
  }
  const rows = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id = $1 LIMIT ${ROW_CAP}`, [tenantId] as never);
  return [...rows].map((r) => camelKeys((r as unknown as { row: unknown }).row));
}

export interface ExportDocument {
  generatedAt: string;
  tenantId: string;
  scope: "contact" | "workspace";
  contactId?: string;
  truncatedAtRows: number;
  data: Record<string, unknown[]>;
}

/** Collect a contact's (and anything merged into it) personal data, or the whole workspace. */
export async function buildExport(tx: Tx, tenantId: string, contactId: string | null, now = new Date()): Promise<ExportDocument> {
  const data: Record<string, unknown[]> = {};
  let ids: string[] | null = null;
  if (contactId) {
    const found = await tx<{ id: string }[]>`
      WITH RECURSIVE m AS (
        SELECT id FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId}
        UNION SELECT c.id FROM contacts c JOIN m ON c.merged_into = m.id WHERE c.tenant_id = ${tenantId})
      SELECT id FROM m`;
    ids = found.map((r) => r.id);
    if (ids.length === 0) throw new FatalJobError("contact not found");
  }
  const scope = ids ?? null;
  const cf = scope ? tx`AND contact_id = ANY(${scope}::uuid[])` : tx``;
  data.contacts = [...(await tx`SELECT id, name, email, phone, custom_attributes, merged_into, first_seen_at, last_seen_at, created_at, updated_at
    FROM contacts WHERE tenant_id = ${tenantId} ${scope ? tx`AND id = ANY(${scope}::uuid[])` : tx``} ORDER BY created_at LIMIT ${ROW_CAP}`)];
  data.contactIdentities = [...(await tx`SELECT id, contact_id, channel, external_id, created_at FROM contact_identities
    WHERE tenant_id = ${tenantId} ${cf} ORDER BY created_at LIMIT ${ROW_CAP}`)];
  data.conversations = [...(await tx`SELECT id, contact_id, channel, widget_id, agent_id, status, handler, assigned_user_id, metadata,
    last_message_at, last_customer_message_at, resolved_at, created_at FROM conversations
    WHERE tenant_id = ${tenantId} ${cf} ORDER BY created_at LIMIT ${ROW_CAP}`)];
  data.messages = [...(await tx`SELECT m.id, m.conversation_id, m.sender_type, m.sender_user_id, m.content, m.ui, m.metadata, m.created_at
    FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
    WHERE m.tenant_id = ${tenantId} ${scope ? tx`AND c.contact_id = ANY(${scope}::uuid[])` : tx``}
    ORDER BY m.created_at, m.id LIMIT ${ROW_CAP}`)];
  data.handoffs = [...(await tx`SELECT h.id, h.conversation_id, h.type, h.reason, h.summary, h.lead_card, h.created_at, h.resolved_at
    FROM handoffs h JOIN conversations c ON c.tenant_id = h.tenant_id AND c.id = h.conversation_id
    WHERE h.tenant_id = ${tenantId} ${scope ? tx`AND c.contact_id = ANY(${scope}::uuid[])` : tx``} ORDER BY h.created_at LIMIT ${ROW_CAP}`)];
  data.conversationAiState = [...(await tx`SELECT s.conversation_id, s.stage, s.lead, s.updated_at FROM conversation_ai_state s
    JOIN conversations c ON c.tenant_id = s.tenant_id AND c.id = s.conversation_id
    WHERE s.tenant_id = ${tenantId} ${scope ? tx`AND c.contact_id = ANY(${scope}::uuid[])` : tx``} LIMIT ${ROW_CAP}`)];
  data.widgetSessions = [...(await tx`SELECT id, widget_id, conversation_id, contact_id, origin, ip, user_agent, created_at, expires_at
    FROM widget_sessions WHERE tenant_id = ${tenantId} ${cf} ORDER BY created_at LIMIT ${ROW_CAP}`)];
  for (const t of OPTIONAL_CONTACT_TABLES) {
    const rows = await optionalRows(tx, t, tenantId, scope);
    if (rows) data[t] = rows;
  }
  if (!scope) {
    // workspace portability extras (no credentials, hashes or secrets)
    data.users = [...(await tx`SELECT id, email, name, role, status, created_at FROM users WHERE tenant_id = ${tenantId} ORDER BY created_at`)];
    data.agents = [...(await tx`SELECT id, name, description, status, created_at, updated_at FROM agents WHERE tenant_id = ${tenantId} ORDER BY created_at`)];
    data.widgets = [...(await tx`SELECT id, name, enabled, allowed_domains, config, prechat, created_at FROM widgets WHERE tenant_id = ${tenantId} ORDER BY created_at`)];
    data.knowledgeSources = [...(await tx`SELECT id, type, name, status, source_url, file_name, mime_type, size_bytes, chunk_count, created_at
      FROM knowledge_sources WHERE tenant_id = ${tenantId} ORDER BY created_at`)];
    data.webhooks = [...(await tx`SELECT id, name, url, events, enabled, created_at FROM webhooks WHERE tenant_id = ${tenantId} ORDER BY created_at`)];
    data.apiKeys = [...(await tx`SELECT id, name, prefix, scopes, created_at, revoked_at FROM api_keys WHERE tenant_id = ${tenantId} ORDER BY created_at`)];
    data.auditLogs = [...(await tx`SELECT id, actor_user_id, action, resource_type, resource_id, metadata, created_at FROM audit_logs
      WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT ${ROW_CAP}`)];
  }
  return { generatedAt: now.toISOString(), tenantId, scope: contactId ? "contact" : "workspace", ...(contactId ? { contactId } : {}), truncatedAtRows: ROW_CAP, data };
}

const trunc = (s: string) => s.slice(0, 500);

interface ReqRow { id: string; kind: string; subjectContactId: string | null; status: string; requestedBy: string | null }

async function loadRequest(ctx: JobContext, requestId: string, kind: "export" | "erasure"): Promise<ReqRow | null> {
  return ctx.withTenant(async (tx) => {
    const [r] = await tx<ReqRow[]>`
      SELECT id, kind, subject_contact_id, status, requested_by FROM gdpr_requests
      WHERE tenant_id = ${ctx.job.tenantId} AND id = ${requestId} AND kind = ${kind} FOR UPDATE`;
    if (!r || r.status === "completed") return null;
    await tx`UPDATE gdpr_requests SET status = 'processing', error = NULL WHERE tenant_id = ${ctx.job.tenantId} AND id = ${requestId}`;
    return r;
  });
}

async function fail(ctx: JobContext, requestId: string, e: unknown): Promise<never> {
  const err = e instanceof Error ? e : new Error(String(e));
  const last = e instanceof FatalJobError || ctx.job.attempts >= ctx.job.maxAttempts;
  await ctx.withTenant((tx) => tx`UPDATE gdpr_requests SET status = ${last ? "failed" : "queued"}, error = ${trunc(err.message)},
    completed_at = ${last ? new Date().toISOString() : null}::timestamptz WHERE tenant_id = ${ctx.job.tenantId} AND id = ${requestId}`);
  throw err;
}

const audit = (tx: Tx, tenantId: string, userId: string | null, action: string, id: string, metadata: Record<string, unknown>) =>
  tx`INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
     VALUES (${tenantId}, ${userId}, ${action}, 'gdpr_request', ${id}, ${tx.json(metadata as never)})`;

export function createGdprExportHandler(deps: { storage: StorageProvider; now?: () => Date }): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (payload: { requestId?: string }, ctx) => {
    const requestId = payload?.requestId ?? "";
    assertUuid(requestId, "requestId");
    const req = await loadRequest(ctx, requestId, "export");
    if (!req) return;
    try {
      const doc = await ctx.withTenant((tx) => buildExport(tx, ctx.job.tenantId, req.subjectContactId, now()));
      const body = JSON.stringify(doc);
      const key = exportKey(ctx.job.tenantId, requestId);
      await deps.storage.put(key, body, { contentType: "application/json" });
      const counts = Object.fromEntries(Object.entries(doc.data).map(([k, v]) => [k, v.length]));
      await ctx.withTenant(async (tx) => {
        await tx`UPDATE gdpr_requests SET status = 'completed', storage_key = ${key}, size_bytes = ${Buffer.byteLength(body)},
          result = ${tx.json({ counts } as never)}, completed_at = now(),
          expires_at = ${new Date(now().getTime() + EXPORT_TTL_DAYS * 86_400_000).toISOString()}::timestamptz
          WHERE tenant_id = ${ctx.job.tenantId} AND id = ${requestId}`;
        await audit(tx, ctx.job.tenantId, req.requestedBy, "gdpr.export.completed", requestId, { scope: doc.scope, contactId: req.subjectContactId });
      });
    } catch (e) {
      await fail(ctx, requestId, e);
    }
  };
}

export function createGdprEraseHandler(deps: { storage: StorageProvider }): JobHandler {
  return async (payload: { requestId?: string }, ctx) => {
    const requestId = payload?.requestId ?? "";
    assertUuid(requestId, "requestId");
    const req = await loadRequest(ctx, requestId, "erasure");
    if (!req) return;
    try {
      if (!req.subjectContactId) throw new FatalJobError("erasure requires a contact");
      const stale = await ctx.withTenant(async (tx) => {
        const [r] = await tx<{ result: Record<string, unknown> }[]>`SELECT gdpr_erase_contact(${ctx.job.tenantId}::uuid, ${req.subjectContactId}::uuid) AS result`;
        // earlier exports of this contact's data must not outlive the erasure
        const old = await tx<{ id: string; storageKey: string }[]>`
          SELECT id, storage_key FROM gdpr_requests WHERE tenant_id = ${ctx.job.tenantId} AND kind = 'export'
            AND subject_contact_id = ${req.subjectContactId} AND storage_key IS NOT NULL`;
        return { result: r!.result, old };
      });
      for (const o of stale.old) await deps.storage.delete(o.storageKey);
      await ctx.withTenant(async (tx) => {
        if (stale.old.length) {
          await tx`UPDATE gdpr_requests SET storage_key = NULL, expires_at = now()
                   WHERE tenant_id = ${ctx.job.tenantId} AND id = ANY(${stale.old.map((o) => o.id)}::uuid[])`;
        }
        await tx`UPDATE gdpr_requests SET status = 'completed', result = ${tx.json(stale.result as never)}, completed_at = now()
                 WHERE tenant_id = ${ctx.job.tenantId} AND id = ${requestId}`;
        await audit(tx, ctx.job.tenantId, req.requestedBy, "gdpr.erasure.completed", requestId, { contactId: req.subjectContactId, ...stale.result });
      });
    } catch (e) {
      await fail(ctx, requestId, e instanceof Error && /contact not found/.test(e.message) ? new FatalJobError(e.message) : e);
    }
  };
}
