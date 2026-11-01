import { withTenant, type Db } from "@yulona/db";
import { hubspotMappingSchema, type HubSpotMapping } from "@yulona/shared";
import { decryptJson, encryptJson } from "./crypto";
import { buildHubSpotProperties, HubSpotClient, HubSpotError, type LeadForCrm } from "./hubspot";
import type { RetryOptions } from "./retry";

const aad = (tenantId: string) => `crm:${tenantId}:hubspot`;
export const sealHubspotToken = (key: string, tenantId: string, token: string) => encryptJson(key, { token }, aad(tenantId));
export const openHubspotToken = (key: string, tenantId: string, env: string) => decryptJson<{ token: string }>(key, env, aad(tenantId)).token;
export const parseHubspotMapping = (raw: unknown): HubSpotMapping => {
  const r = hubspotMappingSchema.safeParse(raw ?? {});
  return r.success ? r.data : hubspotMappingSchema.parse({});
};

/** Structurally compatible with @yulona/queue JobHandlers (kept local so ops does not depend on the queue package). */
type SyncHandlers = Record<string, (payload: any, ctx: { job: { tenantId: string } }) => Promise<void>>;

export interface HubSpotSyncDeps {
  db: Db;
  encryptionKey?: string;
  appUrl?: string;
  /** Tests: fake HubSpot server and fast retries. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  apiBase?: string;
  retry?: RetryOptions;
}

/** Friendly, token-free text stored in `last_error` (shown in the dashboard). */
export const crmErrorText = (e: unknown): string => {
  if (e instanceof HubSpotError) {
    if (e.status === 401) return "HubSpot rejected the access token (revoked or wrong). Reconnect HubSpot.";
    if (e.status === 403) return "The HubSpot token is missing the crm.objects.contacts.read/write scopes. Reconnect HubSpot.";
    return e.message.slice(0, 300);
  }
  return `HubSpot request failed: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}`;
};

/** `crm.hubspot.sync` payload: { conversationId, trigger: 'qualified' | 'booked' }. Idempotent per (conversation, trigger). */
export function createHubSpotJobHandlers(d: HubSpotSyncDeps): SyncHandlers {
  return {
    "crm.hubspot.sync": async (payload: { conversationId: string; trigger: "qualified" | "booked" }, ctx) => {
      const tenantId = ctx.job.tenantId;
      const { conversationId, trigger } = payload;
      const key = d.encryptionKey;
      const state = await withTenant(d.db, tenantId, async (tx) => {
        const [log] = await tx<{ id: string; status: string }[]>`
          SELECT id, status FROM crm_sync_log WHERE tenant_id = ${tenantId} AND provider = 'hubspot' AND conversation_id = ${conversationId} AND trigger = ${trigger} FOR UPDATE`;
        if (!log || log.status === "ok") return { skip: true as const };
        const [conn] = await tx<{ tokenEncrypted: string; settings: unknown }[]>`SELECT token_encrypted, settings FROM crm_connections WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
        if (!conn) {
          await tx`UPDATE crm_sync_log SET status = 'skipped', error = 'HubSpot is not connected' WHERE id = ${log.id}`;
          return { skip: true as const };
        }
        const mapping = parseHubspotMapping(conn.settings);
        if (trigger === "booked" && !mapping.syncOnBooked) {
          await tx`UPDATE crm_sync_log SET status = 'skipped', error = 'Sync on booking is turned off' WHERE id = ${log.id}`;
          return { skip: true as const };
        }
        const [row] = await tx<{ contactId: string | null; lead: LeadForCrm | null; cName: string | null; cEmail: string | null; cPhone: string | null }[]>`
          SELECT c.contact_id, s.lead, ct.name AS c_name, ct.email AS c_email, ct.phone AS c_phone
          FROM conversations c
          LEFT JOIN conversation_ai_state s ON s.tenant_id = c.tenant_id AND s.conversation_id = c.id
          LEFT JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
          WHERE c.tenant_id = ${tenantId} AND c.id = ${conversationId}`;
        const lead: LeadForCrm = { ...(row?.lead ?? {}) };
        lead.email = lead.email || row?.cEmail || undefined;
        lead.name = lead.name || row?.cName || undefined;
        lead.phone = lead.phone || row?.cPhone || undefined;
        if (!row || !lead.email) {
          await tx`UPDATE crm_sync_log SET status = 'skipped', error = 'No email address captured for this lead' WHERE id = ${log.id}`;
          return { skip: true as const };
        }
        await tx`UPDATE crm_sync_log SET attempts = attempts + 1 WHERE id = ${log.id}`;
        return { skip: false as const, logId: log.id, tokenEncrypted: conn.tokenEncrypted, mapping, lead, contactId: row.contactId };
      });
      if (state.skip) return;
      if (!key) throw new Error("ENCRYPTION_KEY is not set");
      const url = d.appUrl ? `${d.appUrl.replace(/\/+$/, "")}/inbox/${conversationId}` : null;
      const client = new HubSpotClient(openHubspotToken(key, tenantId, state.tokenEncrypted), { fetchImpl: d.fetchImpl, apiBase: d.apiBase, retry: d.retry });
      try {
        const r = await client.upsertContact({ email: state.lead.email!.toLowerCase(), properties: buildHubSpotProperties(state.lead, state.mapping, url) });
        await withTenant(d.db, tenantId, async (tx) => {
          await tx`UPDATE crm_sync_log SET status = 'ok', action = ${r.action}, hubspot_id = ${r.id}, error = NULL, synced_at = now(), contact_id = ${state.contactId} WHERE id = ${state.logId}`;
          if (state.contactId) await tx`UPDATE contacts SET hubspot_id = ${r.id}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${state.contactId}`;
          await tx`UPDATE crm_connections SET status = 'active', last_error = NULL, last_sync_at = now(), updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
        });
      } catch (e) {
        const msg = crmErrorText(e);
        const auth = e instanceof HubSpotError && e.authFailure;
        const transient = !(e instanceof HubSpotError) || e.retryable;
        await withTenant(d.db, tenantId, async (tx) => {
          await tx`UPDATE crm_sync_log SET status = 'failed', error = ${msg} WHERE id = ${state.logId}`;
          await tx`UPDATE crm_connections SET last_error = ${msg}, status = ${auth ? "error" : "active"}, updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
        });
        if (transient) throw new Error(msg); // the queue retries with backoff; permanent errors (bad token, bad property) are not retried
      }
    },
  };
}
