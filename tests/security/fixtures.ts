import { encryptCredentials } from "@yulona/crypto";
import { ENC_KEY, mkTenant, type Booted, type Tenant } from "../support";

export const MARK = "ZZMARK";

export interface Fixtures {
  tenant: Tenant;
  mark: string;
  ids: Record<string, string>;
  apiKey: string;
}

/** Seeds one of every tenant resource for a tenant (owner connection; bypasses the app path on purpose). */
export async function seedAll(b: Booted, label: string, tenant?: Tenant): Promise<Fixtures> {
  const t = tenant ?? (await mkTenant(b, label));
  const o = b.owner;
  const mark = `ZZ${label.toUpperCase()}MARK`;
  const tid = t.tenantId;
  const id = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
  const ids: Record<string, string> = { users: t.userId };
  ids.agents = await id(o`INSERT INTO agents (tenant_id, name) VALUES (${tid}, ${`${mark}-agent-${label}`}) RETURNING id`);
  ids.contacts = await id(o`INSERT INTO contacts (tenant_id, name, email) VALUES (${tid}, ${`${mark}-contact-${label}`}, ${`${mark.toLowerCase()}-${label}@example.test`}) RETURNING id`);
  const c2 = await id(o`INSERT INTO contacts (tenant_id, name) VALUES (${tid}, ${`${mark}-contact2-${label}`}) RETURNING id`);
  ids.contacts2 = c2;
  ids.widgets = await id(o`INSERT INTO widgets (tenant_id, name, widget_key) VALUES (${tid}, ${`${mark}-widget-${label}`}, ${`wk_${crypto.randomUUID().replace(/-/g, "")}`}) RETURNING id`);
  ids.conversations = await id(o`INSERT INTO conversations (tenant_id, contact_id) VALUES (${tid}, ${ids.contacts}) RETURNING id`);
  await o`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${tid}, ${ids.conversations}, 'contact', ${`${mark}-message-${label}`})`;
  ids.sources = await id(o`INSERT INTO knowledge_sources (tenant_id, type, name) VALUES (${tid}, 'text', ${`${mark}-source-${label}`}) RETURNING id`);
  ids["canned-responses"] = await id(o`INSERT INTO canned_responses (tenant_id, shortcut, title, content) VALUES (${tid}, ${`zz${label}`}, ${`${mark}-canned`}, 'hello') RETURNING id`);
  ids.tags = await id(o`INSERT INTO tags (tenant_id, name) VALUES (${tid}, ${`${mark}-tag-${label}`}) RETURNING id`);
  await o`INSERT INTO ticket_counters (tenant_id, last) VALUES (${tid}, 2)`;
  ids.tickets = await id(o`INSERT INTO tickets (tenant_id, number, title) VALUES (${tid}, 1, ${`${mark}-ticket-${label}`}) RETURNING id`);
  ids.transactions = await id(o`INSERT INTO transactions (tenant_id, amount_cents, currency, description) VALUES (${tid}, 1500, 'USD', ${`${mark}-tx-${label}`}) RETURNING id`);
  ids["webhook-endpoints"] = await id(o`INSERT INTO transaction_webhook_endpoints (tenant_id, name, secret_encrypted) VALUES (${tid}, ${`${mark}-txep`}, ${encryptCredentials(ENC_KEY, { s: "x" })}) RETURNING id`);
  ids.webhooks = await id(o`INSERT INTO webhooks (tenant_id, name, url, secret_encrypted, events) VALUES (${tid}, ${`${mark}-hook`}, 'https://hooks.example.test/x', ${encryptCredentials(ENC_KEY, { s: "x" })}, ${["message.created"]}) RETURNING id`);
  const evId = crypto.randomUUID();
  ids["webhook-deliveries"] = await id(o`INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload) VALUES (${tid}, ${ids.webhooks}, ${evId}, 'message.created', ${o.json({ marker: mark } as never)}) RETURNING id`);
  ids.connections = await id(o`INSERT INTO channel_connections (tenant_id, channel, name, credentials_encrypted) VALUES (${tid}, 'telegram', ${`${mark}-conn-${label}`}, ${encryptCredentials(ENC_KEY, { botToken: "tok" })}) RETURNING id`);
  ids["tool-connections"] = await id(o`INSERT INTO tool_connections (tenant_id, name, base_url, auth_type, secret_encrypted) VALUES (${tid}, ${`${mark}-toolconn-${label}`}, 'https://shop.example.test', 'bearer', ${encryptCredentials(ENC_KEY, { secret: "x" })}) RETURNING id`);
  ids.sessions = await id(o`INSERT INTO builder_sessions (tenant_id, user_id) VALUES (${tid}, ${t.userId}) RETURNING id`);
  ids["api-keys"] = await id(o`INSERT INTO api_keys (tenant_id, name, prefix, key_hash) VALUES (${tid}, ${`${mark}-key`}, ${`yl_${label}`}, ${crypto.randomUUID()}) RETURNING id`);
  ids.invitations = await id(o`INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at) VALUES (${tid}, ${`inv-${label}@example.test`}, 'agent', ${crypto.randomUUID()}, now() + interval '1 day') RETURNING id`);
  ids.bookings = await id(o`INSERT INTO bookings (tenant_id, title, start_at, end_at, contact_id) VALUES (${tid}, ${`${mark}-booking-${label}`}, now() + interval '1 day', now() + interval '1 day 1 hour', ${ids.contacts}) RETURNING id`);
  ids["needs-attention"] = await id(o`INSERT INTO handoffs (tenant_id, conversation_id, type, reason) VALUES (${tid}, ${ids.conversations}, 'uncertainty', ${`${mark}-handoff`}) RETURNING id`);
  ids.notifications = await id(o`INSERT INTO notifications (tenant_id, user_id, type, title) VALUES (${tid}, ${t.userId}, 'test', ${`${mark}-notification`}) RETURNING id`);
  ids.requests = await id(o`INSERT INTO gdpr_requests (tenant_id, kind) VALUES (${tid}, 'export') RETURNING id`);
  ids["merge-suggestions"] = await id(o`INSERT INTO contact_merge_suggestions (tenant_id, primary_contact_id, other_contact_id, reason) VALUES (${tid}, ${ids.contacts}, ${c2}, 'same_email') RETURNING id`);
  await o`INSERT INTO tickets (tenant_id, number, title, contact_id, conversation_id) VALUES (${tid}, 2, ${`${mark}-ticket2`}, ${ids.contacts}, ${ids.conversations})`;

  // a real API key for the public-api realm
  const apiKey = `yl_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}_${crypto.randomUUID().replace(/-/g, "")}`;
  const { sha256 } = await import("../../apps/api/src/security");
  await o`INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes) VALUES (${tid}, 'sweep', ${apiKey.slice(0, 11)}, ${sha256(apiKey)}, ${["conversations:read", "conversations:write", "contacts:read", "contacts:write", "knowledge:read", "knowledge:write", "bookings:read", "bookings:write"]})`;
  return { tenant: t, mark, ids, apiKey };
}

/** md5 fingerprint of every tenant-scoped row of a tenant, per table. */
export async function snapshot(b: Booted, tenantId: string): Promise<Record<string, string>> {
  const tables = await b.owner<{ t: string }[]>`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY 1`;
  const out: Record<string, string> = {};
  for (const { t } of tables) {
    // updated_at/last_seen style columns are included on purpose: the attacker must not touch rows at all
    const [r] = await b.owner.unsafe<{ n: number; h: string }[]>(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x WHERE tenant_id = '${tenantId}'`);
    out[t] = `${r!.n}:${r!.h}`;
  }
  return out;
}
