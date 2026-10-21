import type { Db } from "./client";

/**
 * Pre-auth path: the only cross-tenant access the app role has. Backed by narrowly scoped
 * SECURITY DEFINER functions (see migrations/0001_init.sql). Each returns the minimum needed.
 */
export interface PreauthUser {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "agent";
  passwordHash: string;
  lockedUntil: Date | null;
  userStatus: "active" | "disabled";
  tenantStatus: "active" | "suspended" | "deleted";
}
export type RotateResult =
  | { status: "ok" | "reuse"; tenantId: string; userId: string; familyId: string }
  | { status: "invalid" };

export function createPreauth(db: Db) {
  return {
    async findUserByEmail(email: string): Promise<PreauthUser | undefined> {
      const [row] = await db<PreauthUser[]>`SELECT * FROM auth_find_user(${email})`;
      return row;
    },
    async register(i: {
      workspaceName: string;
      email: string;
      passwordHash: string;
      name: string;
      ip?: string | null;
      requestId?: string | null;
    }): Promise<{ tenantId: string; userId: string }> {
      const [row] = await db<{ rTenantId: string; rUserId: string }[]>`
        SELECT * FROM auth_register(${i.workspaceName}, ${i.email}, ${i.passwordHash}, ${i.name},
                                    ${i.ip ?? null}, ${i.requestId ?? null})`;
      return { tenantId: row!.rTenantId, userId: row!.rUserId };
    },
    async recordLogin(userId: string, success: boolean): Promise<void> {
      await db`SELECT auth_record_login(${userId}, ${success})`;
    },
    async rotateRefresh(i: {
      oldHash: string;
      newHash: string;
      expiresAt: Date;
      userAgent?: string | null;
      ip?: string | null;
    }): Promise<RotateResult> {
      const [r] = await db<{ rStatus: string; rTenantId: string | null; rUserId: string | null; rFamilyId: string | null }[]>`
        SELECT * FROM auth_rotate_refresh(${i.oldHash}, ${i.newHash}, ${i.expiresAt.toISOString()}::timestamptz,
                                          ${i.userAgent?.slice(0, 256) ?? null}, ${i.ip ?? null})`;
      if (!r || r.rStatus === "invalid" || !r.rTenantId || !r.rUserId || !r.rFamilyId) return { status: "invalid" };
      return { status: r.rStatus as "ok" | "reuse", tenantId: r.rTenantId, userId: r.rUserId, familyId: r.rFamilyId };
    },
    async revokeFamilyByHash(hash: string): Promise<{ tenantId: string; userId: string } | undefined> {
      const [r] = await db<{ rTenantId: string; rUserId: string }[]>`SELECT * FROM auth_revoke_refresh_family(${hash})`;
      return r ? { tenantId: r.rTenantId, userId: r.rUserId } : undefined;
    },
  };
}
export type Preauth = ReturnType<typeof createPreauth>;
