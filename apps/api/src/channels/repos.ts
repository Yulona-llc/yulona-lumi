import { TenantRepository, type Db, type Tx } from "@yulona/db";

export interface ConnectionRow {
  id: string;
  channel: "whatsapp" | "facebook" | "instagram" | "telegram" | "slack";
  name: string;
  externalId: string | null;
  agentId: string | null;
  status: "active" | "disabled" | "error";
  credentialsEncrypted: string;
  lastHealthAt: Date | null;
  lastHealthOk: boolean | null;
  lastHealthError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const cols = (tx: Tx) => tx`id, channel, name, external_id, agent_id, status, credentials_encrypted, last_health_at, last_health_ok, last_health_error, created_at, updated_at`;

export class ConnectionsRepository extends TenantRepository {
  list(): Promise<ConnectionRow[]> {
    const tx = this.tx;
    return tx<ConnectionRow[]>`SELECT ${cols(tx)} FROM channel_connections WHERE tenant_id = ${this.tenantId} ORDER BY created_at, id`;
  }
  async get(id: string, lock = false): Promise<ConnectionRow | undefined> {
    const tx = this.tx;
    const [row] = await tx<ConnectionRow[]>`SELECT ${cols(tx)} FROM channel_connections WHERE tenant_id = ${this.tenantId} AND id = ${id} ${lock ? tx`FOR UPDATE` : tx``}`;
    return row;
  }
  async create(i: { id: string; channel: string; name: string; externalId: string | null; agentId: string | null; credentialsEncrypted: string }): Promise<ConnectionRow> {
    const [row] = await this.tx<ConnectionRow[]>`
      INSERT INTO channel_connections (id, tenant_id, channel, name, external_id, agent_id, credentials_encrypted)
      VALUES (${i.id}, ${this.tenantId}, ${i.channel}, ${i.name}, ${i.externalId}, ${i.agentId}, ${i.credentialsEncrypted})
      RETURNING id, channel, name, external_id, agent_id, status, credentials_encrypted, last_health_at, last_health_ok, last_health_error, created_at, updated_at`;
    return row!;
  }
  async update(id: string, p: { name?: string; agentId?: string | null; status?: string; externalId?: string | null; credentialsEncrypted?: string }): Promise<void> {
    const tx = this.tx;
    await tx`
      UPDATE channel_connections SET
        name = ${p.name ?? tx`name`},
        agent_id = ${p.agentId === undefined ? tx`agent_id` : p.agentId},
        status = ${p.status ?? tx`status`},
        external_id = ${p.externalId === undefined ? tx`external_id` : p.externalId},
        credentials_encrypted = ${p.credentialsEncrypted ?? tx`credentials_encrypted`},
        updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }
  async recordHealth(id: string, ok: boolean, error: string | null): Promise<void> {
    await this.tx`
      UPDATE channel_connections SET last_health_at = now(), last_health_ok = ${ok}, last_health_error = ${error},
        status = CASE WHEN status = 'disabled' THEN status WHEN ${ok} THEN 'active' ELSE 'error' END, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }
  async delete(id: string): Promise<boolean> {
    const r = await this.tx`DELETE FROM channel_connections WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING id`;
    return r.length > 0;
  }
  async agentExists(agentId: string): Promise<boolean> {
    const r = await this.tx`SELECT 1 FROM agents WHERE tenant_id = ${this.tenantId} AND id = ${agentId}`;
    return r.length > 0;
  }
}

export interface ResolvedConnection {
  connectionId: string;
  tenantId: string;
  channel: ConnectionRow["channel"];
  status: ConnectionRow["status"];
  agentId: string | null;
  credentialsEncrypted: string;
  tenantStatus: string;
}
/** Pre-auth lookup used by the public webhook receivers (SECURITY DEFINER function, migration 0600). */
export async function resolveConnection(db: Db, id: string): Promise<ResolvedConnection | undefined> {
  const [r] = await db<ResolvedConnection[]>`SELECT * FROM channel_connection_resolve(${id})`;
  return r;
}

export interface SuggestionRow {
  id: string;
  reason: "same_email" | "same_phone" | "same_name";
  createdAt: Date;
  pId: string; pName: string | null; pEmail: string | null; pPhone: string | null;
  oId: string; oName: string | null; oEmail: string | null; oPhone: string | null;
}
export class MergeSuggestionsRepository extends TenantRepository {
  list(limit: number): Promise<SuggestionRow[]> {
    return this.tx<SuggestionRow[]>`
      SELECT s.id, s.reason, s.created_at,
             p.id AS p_id, p.name AS p_name, p.email AS p_email, p.phone AS p_phone,
             o.id AS o_id, o.name AS o_name, o.email AS o_email, o.phone AS o_phone
      FROM contact_merge_suggestions s
      JOIN contacts p ON p.tenant_id = s.tenant_id AND p.id = s.primary_contact_id
      JOIN contacts o ON o.tenant_id = s.tenant_id AND o.id = s.other_contact_id
      WHERE s.tenant_id = ${this.tenantId} AND s.status = 'pending' AND p.merged_into IS NULL AND o.merged_into IS NULL
      ORDER BY s.created_at DESC, s.id LIMIT ${limit}`;
  }
  async dismiss(id: string): Promise<boolean> {
    const r = await this.tx`UPDATE contact_merge_suggestions SET status = 'dismissed' WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING id`;
    return r.length > 0;
  }
}
