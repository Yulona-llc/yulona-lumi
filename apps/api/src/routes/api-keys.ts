import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { TenantRepository, withTenant, type Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { enforceLimit, requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { assertWithinLimit } from "../platform/limits";
import { audit, parseId } from "../platform/util";
import type { RateLimiter } from "../ratelimit";
import { newOpaqueToken, sha256 } from "../security";

export const API_KEY_SCOPES = [
  "conversations:read", "conversations:write", "contacts:read", "contacts:write", "knowledge:read", "knowledge:write",
  "bookings:read", "bookings:write",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type ApiKeyEnv = { Variables: AppEnv["Variables"] & { apiKey: { id: string; name: string; scopes: string[] } } };

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).default(60),
  expiresAt: z.iso.datetime().optional(),
});

interface KeyRow {
  id: string; name: string; prefix: string; scopes: string[]; rateLimitPerMinute: number;
  expiresAt: Date | null; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date; createdBy: string | null;
}
const dto = (k: KeyRow) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, rateLimitPerMinute: k.rateLimitPerMinute,
  expiresAt: k.expiresAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null,
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null, createdAt: k.createdAt.toISOString(), createdBy: k.createdBy,
});

class ApiKeysRepository extends TenantRepository {
  list() {
    return this.tx<KeyRow[]>`SELECT id, name, prefix, scopes, rate_limit_per_minute, expires_at, revoked_at, last_used_at, created_at, created_by
      FROM api_keys WHERE tenant_id = ${this.tenantId} ORDER BY created_at DESC`;
  }
  async create(i: { name: string; prefix: string; hash: string; scopes: string[]; rl: number; expiresAt: string | null; by: string }) {
    const [r] = await this.tx<KeyRow[]>`
      INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes, rate_limit_per_minute, expires_at, created_by)
      VALUES (${this.tenantId}, ${i.name}, ${i.prefix}, ${i.hash}, ${i.scopes}, ${i.rl}, ${i.expiresAt}::timestamptz, ${i.by})
      RETURNING id, name, prefix, scopes, rate_limit_per_minute, expires_at, revoked_at, last_used_at, created_at, created_by`;
    return r!;
  }
  async revoke(id: string) {
    const r = await this.tx`UPDATE api_keys SET revoked_at = now() WHERE tenant_id = ${this.tenantId} AND id = ${id} AND revoked_at IS NULL RETURNING id`;
    return r.length > 0;
  }
}

export function apiKeyRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.use("/api-keys/*", requireAuth(cfg), requireMinRole("admin"));

  r.get("/api-keys", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new ApiKeysRepository(tx, tenantId).list());
    return c.json({ items: rows.map(dto) });
  });

  r.post("/api-keys", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const body = await parseBody(c, createSchema);
    if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now()) throw Errors.validation([{ path: "expiresAt", message: "Must be in the future" }]);
    const prefix = `yl_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const key = `${prefix}_${newOpaqueToken(32)}`;
    const row = await withTenant(db, tenantId, async (tx) => {
      await assertWithinLimit(tx, tenantId, "api_keys");
      const k = await new ApiKeysRepository(tx, tenantId).create({
        name: body.name, prefix, hash: sha256(key), scopes: body.scopes, rl: body.rateLimitPerMinute, expiresAt: body.expiresAt ?? null, by: userId,
      });
      await audit(tx, c, "api_key.created", "api_key", k.id, { name: body.name, prefix, scopes: body.scopes });
      return k;
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ...dto(row), key }, 201); // the only time the full key is ever returned
  });

  r.delete("/api-keys/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const done = await new ApiKeysRepository(tx, tenantId).revoke(id);
      if (done) await audit(tx, c, "api_key.revoked", "api_key", id);
      return done;
    });
    if (!ok) throw Errors.notFound("API key not found");
    return c.json({ ok: true as const });
  });
  return r;
}

/**
 * Authenticates `Authorization: Bearer yl_...` (tenant API key), sets `auth` ({tenantId, role: "agent",
 * userId: <key id>}) and `apiKey`, and enforces the key's per-minute rate limit. Use for the public API.
 */
export const requireApiKey = (db: Db, limiter: RateLimiter): MiddlewareHandler<ApiKeyEnv> => async (c, next) => {
  const m = /^Bearer (yl_[0-9a-f]{8}_[A-Za-z0-9_-]{20,100})$/.exec(c.req.header("authorization") ?? "");
  if (!m) throw Errors.unauthorized("API key required");
  const [row] = await db<{ keyId: string; tenantId: string; name: string; scopes: string[]; rateLimitPerMinute: number }[]>`
    SELECT * FROM api_key_resolve(${sha256(m[1]!)})`;
  if (!row) throw Errors.unauthorized("Invalid API key");
  await enforceLimit(limiter, `apikey:${row.keyId}`, { limit: row.rateLimitPerMinute, windowMs: 60_000 });
  c.set("auth", { userId: row.keyId, tenantId: row.tenantId, role: "agent" });
  c.set("apiKey", { id: row.keyId, name: row.name, scopes: row.scopes });
  await next();
};

export const requireScope = (scope: ApiKeyScope): MiddlewareHandler<ApiKeyEnv> => async (c, next) => {
  if (!c.get("apiKey")?.scopes.includes(scope)) throw Errors.forbidden(`API key lacks scope ${scope}`);
  await next();
};

/** GET /api/v1/key-info: introspection endpoint for API-key clients (also exercises the middleware). */
export function apiKeyInfoRoutes({ db, limiter }: { db: Db; limiter: RateLimiter }) {
  const r = new Hono<ApiKeyEnv>();
  r.get("/key-info", requireApiKey(db, limiter), (c) => c.json({ ...c.get("apiKey"), tenantId: c.get("auth").tenantId }));
  return r;
}
