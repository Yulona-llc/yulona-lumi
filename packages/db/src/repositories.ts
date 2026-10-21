import { TenantRepository } from "./tenant";

export interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent" | "viewer";
  status: "active" | "disabled";
}
export interface TenantRow {
  id: string;
  name: string;
  status: "active" | "suspended" | "deleted";
}

export class TenantsRepository extends TenantRepository {
  async get(): Promise<TenantRow | undefined> {
    const [row] = await this.tx<TenantRow[]>`
      SELECT id, name, status FROM tenants WHERE id = ${this.tenantId}`;
    return row;
  }
}

export class UsersRepository extends TenantRepository {
  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.tx<UserRow[]>`
      SELECT id, tenant_id, email, name, role, status FROM users
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return row;
  }
}

export class RefreshTokensRepository extends TenantRepository {
  async create(input: {
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  }): Promise<void> {
    await this.tx`
      INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at, user_agent, ip)
      VALUES (${this.tenantId}, ${input.userId}, ${input.familyId}, ${input.tokenHash},
              ${input.expiresAt.toISOString()}::timestamptz, ${input.userAgent?.slice(0, 256) ?? null}, ${input.ip ?? null})`;
  }
  async revokeFamily(familyId: string): Promise<void> {
    await this.tx`
      UPDATE refresh_tokens SET revoked_at = now()
      WHERE tenant_id = ${this.tenantId} AND family_id = ${familyId} AND revoked_at IS NULL`;
  }
}

export class AuditLogRepository extends TenantRepository {
  async record(e: {
    actorUserId?: string | null;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
    requestId?: string | null;
  }): Promise<void> {
    await this.tx`
      INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, metadata, ip, request_id)
      VALUES (${this.tenantId}, ${e.actorUserId ?? null}, ${e.action}, ${e.resourceType ?? null},
              ${e.resourceId ?? null}, ${this.tx.json((e.metadata ?? {}) as never)}, ${e.ip ?? null}, ${e.requestId ?? null})`;
  }
}
