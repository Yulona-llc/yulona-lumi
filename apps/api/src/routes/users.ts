import { Hono } from "hono";
import { z } from "zod";
import { TenantRepository, withTenant, type Db } from "@yulona/db";
import { emailSchema, passwordSchema, roleSchema, type Role } from "@yulona/shared";
import type { Providers } from "@yulona/providers";
import type { Logger } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { enforceLimit, requireAuth } from "../middleware";
import { ROLE_RANK, requireMinRole } from "../platform/authz";
import { assertWithinLimit } from "../platform/limits";
import { audit, isUniqueViolation, parseId } from "../platform/util";
import type { RateLimiter } from "../ratelimit";
import { hashPassword, newOpaqueToken, sha256 } from "../security";

export interface UserDto {
  id: string; email: string; name: string; role: Role; status: "active" | "disabled"; lastLoginAt: string | null; createdAt: string;
}
interface UserRow { id: string; email: string; name: string; role: Role; status: "active" | "disabled"; lastLoginAt: Date | null; createdAt: Date }
const toDto = (r: UserRow): UserDto => ({
  id: r.id, email: r.email, name: r.name, role: r.role, status: r.status,
  lastLoginAt: r.lastLoginAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
});

class MembersRepository extends TenantRepository {
  list() {
    return this.tx<UserRow[]>`SELECT id, email, name, role, status, last_login_at, created_at FROM users
      WHERE tenant_id = ${this.tenantId} ORDER BY created_at`;
  }
  async get(id: string, lock = false) {
    const [r] = lock
      ? await this.tx<UserRow[]>`SELECT id, email, name, role, status, last_login_at, created_at FROM users WHERE tenant_id = ${this.tenantId} AND id = ${id} FOR UPDATE`
      : await this.tx<UserRow[]>`SELECT id, email, name, role, status, last_login_at, created_at FROM users WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r;
  }
  async otherActiveOwners(excludeId: string) {
    const rows = await this.tx<{ id: string }[]>`SELECT id FROM users WHERE tenant_id = ${this.tenantId} AND role = 'owner' AND status = 'active' AND id <> ${excludeId} FOR UPDATE`;
    return rows.length;
  }
}

class InvitationsRepository extends TenantRepository {
  list() {
    return this.tx<{ id: string; email: string; role: Role; expiresAt: Date; createdAt: Date; invitedBy: string | null; status: string }[]>`
      SELECT id, email, role, expires_at, created_at, invited_by,
        CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
             WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END AS status
      FROM invitations WHERE tenant_id = ${this.tenantId} ORDER BY created_at DESC LIMIT 200`;
  }
  async create(i: { email: string; role: Role; tokenHash: string; invitedBy: string; expiresAt: Date }) {
    const [r] = await this.tx<{ id: string }[]>`
      INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${this.tenantId}, ${i.email}, ${i.role}, ${i.tokenHash}, ${i.invitedBy}, ${i.expiresAt.toISOString()}::timestamptz) RETURNING id`;
    return r!.id;
  }
  async revoke(id: string) {
    const r = await this.tx`UPDATE invitations SET revoked_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`;
    return r.length > 0;
  }
  async emailInUse(email: string) {
    // users.email is globally unique; this RLS-scoped check only sees our tenant, the INSERT at accept time is authoritative.
    const r = await this.tx`SELECT 1 FROM users WHERE tenant_id = ${this.tenantId} AND lower(email) = lower(${email})`;
    return r.length > 0;
  }
}

const patchUserSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  role: roleSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((v) => Object.keys(v).length > 0, "At least one field required");
const inviteSchema = z.strictObject({ email: emailSchema, role: roleSchema });
const acceptSchema = z.strictObject({
  token: z.string().min(20).max(128),
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
});

const INVITE_TTL_MS = 7 * 86_400_000;

export function userRoutes({ cfg, db, limiter, providers, log }: { cfg: Config; db: Db; limiter: RateLimiter; providers: Providers; log: Logger }) {
  const r = new Hono<AppEnv>();

  // Public: accept an invitation (token is the credential; tenant is derived from it).
  r.post("/invitations/accept", async (c) => {
    await enforceLimit(limiter, `invacc:${c.get("ip")}`, cfg.rateLimits.register);
    const body = await parseBody(c, acceptSchema);
    const passwordHash = await hashPassword(body.password);
    try {
      const [row] = await db<{ rTenantId: string; rUserId: string; rRole: string }[]>`
        SELECT * FROM invitation_accept(${sha256(body.token)}, ${body.name}, ${passwordHash})`;
      return c.json({ ok: true as const, role: row!.rRole }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("This email already has an account");
      if ((e as Error).message?.includes("invalid_invitation")) throw new AppError(400, "validation_error", "Invitation is invalid or expired");
      throw e;
    }
  });

  
  r.use("/users/*", requireAuth(cfg));
  r.use("/invitations/*", requireAuth(cfg));

  r.get("/users", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new MembersRepository(tx, tenantId).list());
    return c.json({ items: rows.map(toDto) });
  });

  r.patch("/users/:id", requireMinRole("admin"), async (c) => {
    const { tenantId, userId: actorId, role: actorRole } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, patchUserSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const repo = new MembersRepository(tx, tenantId);
      const target = await repo.get(id, true);
      if (!target) throw Errors.notFound("User not found");
      const self = id === actorId;
      const touchesAccess = body.role !== undefined || body.status !== undefined;
      if (self && touchesAccess) throw Errors.forbidden("You cannot change your own role or status");
      if (touchesAccess && actorRole !== "owner") {
        if (ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) throw Errors.forbidden("Cannot modify a user with an equal or higher role");
        if (body.role && ROLE_RANK[body.role] > ROLE_RANK[actorRole]) throw Errors.forbidden("Cannot grant a higher role than your own");
      }
      const demotes = target.role === "owner" && ((body.role && body.role !== "owner") || body.status === "disabled");
      if (demotes && (await repo.otherActiveOwners(id)) === 0) throw Errors.conflict("A workspace must keep at least one active owner");
      const [u] = await tx<UserRow[]>`
        UPDATE users SET name = COALESCE(${body.name ?? null}, name), role = COALESCE(${body.role ?? null}, role),
          status = COALESCE(${body.status ?? null}, status), updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id}
        RETURNING id, email, name, role, status, last_login_at, created_at`;
      if (body.status === "disabled") {
        await tx`UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = ${tenantId} AND user_id = ${id} AND revoked_at IS NULL`;
      }
      if (body.status === "active" && target.status === "disabled") await assertWithinLimit(tx, tenantId, "seats", 0);
      await audit(tx, c, "user.updated", "user", id, { changes: body, previousRole: target.role, previousStatus: target.status });
      return u!;
    });
    return c.json(toDto(out));
  });

  r.get("/invitations", requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new InvitationsRepository(tx, tenantId).list());
    return c.json({ items: rows.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() })) });
  });

  r.post("/invitations", requireMinRole("admin"), async (c) => {
    const { tenantId, userId, role: actorRole } = c.get("auth");
    await enforceLimit(limiter, `invite:${tenantId}`, { limit: 30, windowMs: 60 * 60_000 });
    const body = await parseBody(c, inviteSchema);
    if (ROLE_RANK[body.role] > ROLE_RANK[actorRole]) throw Errors.forbidden("Cannot invite a higher role than your own");
    const token = newOpaqueToken(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    let id: string;
    let tenantName = "your workspace";
    try {
      id = await withTenant(db, tenantId, async (tx) => {
        await assertWithinLimit(tx, tenantId, "seats");
        const repo = new InvitationsRepository(tx, tenantId);
        if (await repo.emailInUse(body.email)) throw Errors.conflict("This email already belongs to a member");
        const [t] = await tx<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${tenantId}`;
        if (t) tenantName = t.name;
        const invId = await repo.create({ email: body.email, role: body.role, tokenHash: sha256(token), invitedBy: userId, expiresAt });
        await audit(tx, c, "invitation.created", "invitation", invId, { email: body.email, role: body.role });
        return invId;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("An invitation for this email is already pending");
      throw e;
    }
    const inviteUrl = `${cfg.appUrl.replace(/\/+$/, "")}/accept-invite?token=${token}`;
    let emailSent = true;
    try {
      await providers.email.send({
        to: body.email,
        subject: `You're invited to join ${tenantName} on Lumi`,
        text: `You have been invited to join ${tenantName} as ${body.role}.\n\nAccept the invitation (valid 7 days): ${inviteUrl}\n`,
      });
    } catch (e) {
      emailSent = false;
      log.warn("invitation email failed", { invitationId: id, err: (e as Error).message });
    }
    return c.json({ id, email: body.email, role: body.role, expiresAt: expiresAt.toISOString(), emailSent, ...(cfg.isProd ? {} : { inviteUrl }) }, 201);
  });

  r.delete("/invitations/:id", requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const done = await new InvitationsRepository(tx, tenantId).revoke(id);
      if (done) await audit(tx, c, "invitation.revoked", "invitation", id);
      return done;
    });
    if (!ok) throw Errors.notFound("Pending invitation not found");
    return c.json({ ok: true as const });
  });

  return r;
}
