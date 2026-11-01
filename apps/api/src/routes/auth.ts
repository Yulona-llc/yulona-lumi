import { Hono, type Context } from "hono";
import { z } from "zod";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  CSRF_COOKIE, CSRF_HEADER, REFRESH_COOKIE, loginSchema, registerSchema,
  type Session,
} from "@yulona/shared";
import {
  AuditLogRepository, RefreshTokensRepository, TenantsRepository, UsersRepository, withTenant,
  type Db, type Preauth,
} from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { enforceLimit } from "../middleware";
import { IMPERSONATION_TTL_S } from "../impersonation-guard";
import type { RateLimiter } from "../ratelimit";
import { hashPassword, newOpaqueToken, safeEqual, sha256, signAccessToken, verifyPassword } from "../security";

interface Deps {
  cfg: Config;
  db: Db;
  preauth: Preauth;
  limiter: RateLimiter;
}

export function authRoutes({ cfg, db, preauth, limiter }: Deps) {
  const r = new Hono<AppEnv>();
  const refreshTtlMs = cfg.refreshTokenTtlDays * 86_400_000;
  const sameSite = cfg.crossSiteCookies ? "None" : "Strict";
  const ua = (c: Context) => c.req.header("user-agent") ?? null;

  function setAuthCookies(c: Context, refreshToken: string, expires: Date) {
    const base = { secure: cfg.cookieSecure, sameSite, expires } as const;
    setCookie(c, REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true, path: "/api/v1/auth" });
    const csrf = newOpaqueToken(24);
    setCookie(c, CSRF_COOKIE, csrf, { ...base, httpOnly: false, path: "/" });
    // Cross-site dashboards cannot read this API's cookie; they can read this exposed header instead.
    c.header(CSRF_HEADER, csrf);
  }
  function clearAuthCookies(c: Context) {
    deleteCookie(c, REFRESH_COOKIE, { path: "/api/v1/auth", secure: cfg.cookieSecure, sameSite });
    deleteCookie(c, CSRF_COOKIE, { path: "/", secure: cfg.cookieSecure, sameSite });
  }
  function checkCsrf(c: Context) {
    const cookie = getCookie(c, CSRF_COOKIE);
    const header = c.req.header(CSRF_HEADER);
    if (!cookie || !header || !safeEqual(cookie, header)) throw Errors.csrf();
  }
  // Cross-origin dashboards cannot read this API's cookies. The CORS allowlist makes this response
  // unreadable to other origins, so handing the token to an allowed origin is safe (double-submit holds).
  r.get("/csrf", (c) => {
    const csrf = getCookie(c, CSRF_COOKIE) ?? newOpaqueToken(24);
    setCookie(c, CSRF_COOKIE, csrf, {
      secure: cfg.cookieSecure, sameSite, httpOnly: false, path: "/",
      expires: new Date(Date.now() + refreshTtlMs),
    });
    c.header(CSRF_HEADER, csrf);
    c.header("Cache-Control", "no-store");
    return c.json({ csrfToken: csrf });
  });
  async function loadSession(tenantId: string, userId: string): Promise<Session | null> {
    const found = await withTenant(db, tenantId, async (tx) => ({
      user: await new UsersRepository(tx, tenantId).findById(userId),
      tenant: await new TenantsRepository(tx, tenantId).get(),
    }));
    if (!found.user || !found.tenant || found.user.status !== "active" || found.tenant.status !== "active") return null;
    const accessToken = await signAccessToken(cfg.jwtSecret, {
      userId, tenantId, role: found.user.role, ttlSeconds: cfg.accessTokenTtlSeconds,
    });
    return {
      accessToken,
      expiresIn: cfg.accessTokenTtlSeconds,
      user: { id: found.user.id, email: found.user.email, name: found.user.name, role: found.user.role },
      tenant: { id: found.tenant.id, name: found.tenant.name },
    };
  }
  /** Start a brand-new refresh family for a freshly authenticated user. */
  async function startSession(c: Context<AppEnv>, tenantId: string, userId: string, auditAction: string) {
    const token = newOpaqueToken();
    const expires = new Date(Date.now() + refreshTtlMs);
    await withTenant(db, tenantId, async (tx) => {
      await new RefreshTokensRepository(tx, tenantId).create({
        userId, familyId: crypto.randomUUID(), tokenHash: sha256(token), expiresAt: expires, userAgent: ua(c), ip: c.get("ip"),
      });
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: auditAction, resourceType: "user", resourceId: userId, ip: c.get("ip"), requestId: c.get("requestId"),
      });
    });
    const session = await loadSession(tenantId, userId);
    if (!session) throw Errors.invalidCredentials();
    setAuthCookies(c, token, expires);
    return session;
  }

  // The only coupling with the platform-admin service: redeem its one-time code (60 s, single use, stored hashed)
  // for a 15-minute impersonation token. The admin service never holds a tenant signing key.
  r.post("/impersonation/exchange", async (c) => {
    await enforceLimit(limiter, `imp-exchange:${c.get("ip")}`, { limit: 20, windowMs: 60_000 });
    const body = await parseBody(c, z.strictObject({ code: z.string().min(16).max(200) }));
    const [x] = await db<{ rStatus: string; rSession: string; rAdmin: string; rTenant: string; rUser: string; rRole: "admin" | "agent" | "viewer"; rReadOnly: boolean; rEmail: string; rName: string; rTenantName: string; rExpires: Date }[]>`
      SELECT * FROM impersonation_exchange(${sha256(body.code)})`;
    if (!x || x.rStatus !== "ok") throw Errors.validation([{ path: "code", message: "Code is invalid, expired or already used" }]);
    const ttl = Math.max(1, Math.min(IMPERSONATION_TTL_S, Math.round((x.rExpires.getTime() - Date.now()) / 1000)));
    const accessToken = await signAccessToken(cfg.jwtSecret, {
      userId: x.rUser, tenantId: x.rTenant, role: x.rRole, ttlSeconds: ttl, impersonation: { adminId: x.rAdmin, sessionId: x.rSession, readOnly: x.rReadOnly },
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      accessToken, expiresIn: ttl, sessionId: x.rSession, readOnly: x.rReadOnly,
      user: { id: x.rUser, email: x.rEmail, name: x.rName, role: x.rRole }, tenant: { id: x.rTenant, name: x.rTenantName },
    });
  });

  r.post("/register", async (c) => {
    if (!cfg.allowPublicSignup) throw Errors.signupDisabled();
    await enforceLimit(limiter, `reg:${c.get("ip")}`, cfg.rateLimits.register);
    const body = await parseBody(c, registerSchema);
    const passwordHash = await hashPassword(body.password);
    let ids: { tenantId: string; userId: string };
    try {
      ids = await preauth.register({
        workspaceName: body.workspaceName, email: body.email, passwordHash, name: body.name, ip: c.get("ip"), requestId: c.get("requestId"),
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw Errors.conflict("Unable to register with these details");
      throw e;
    }
    return c.json(await startSession(c, ids.tenantId, ids.userId, "auth.login"), 201);
  });

  r.post("/login", async (c) => {
    const body = await parseBody(c, loginSchema);
    const ip = c.get("ip");
    await enforceLimit(limiter, `login:ip:${ip}`, cfg.rateLimits.loginIp);
    await enforceLimit(limiter, `login:ipemail:${ip}:${body.email}`, cfg.rateLimits.loginIpEmail);

    const user = await preauth.findUserByEmail(body.email);
    const passwordOk = await verifyPassword(body.password, user?.passwordHash);
    const locked = !!user?.lockedUntil && user.lockedUntil.getTime() > Date.now();
    const usable = !!user && user.userStatus === "active" && user.tenantStatus === "active";

    if (!user || !usable || locked || !passwordOk) {
      if (user && usable && !locked) {
        await preauth.recordLogin(user.userId, false);
        await withTenant(db, user.tenantId, (tx) =>
          new AuditLogRepository(tx, user.tenantId).record({
            actorUserId: user.userId, action: "auth.login_failed", resourceType: "user", resourceId: user.userId, ip, requestId: c.get("requestId"),
          }));
      }
      throw Errors.invalidCredentials(); // identical response for every failure mode
    }
    await preauth.recordLogin(user.userId, true);
    return c.json(await startSession(c, user.tenantId, user.userId, "auth.login"));
  });

  r.post("/refresh", async (c) => {
    await enforceLimit(limiter, `refresh:${c.get("ip")}`, cfg.rateLimits.refresh);
    checkCsrf(c);
    const old = getCookie(c, REFRESH_COOKIE);
    if (!old || old.length > 256) throw Errors.invalidRefresh();
    const next = newOpaqueToken();
    const expires = new Date(Date.now() + refreshTtlMs);
    const res = await preauth.rotateRefresh({ oldHash: sha256(old), newHash: sha256(next), expiresAt: expires, userAgent: ua(c), ip: c.get("ip") });
    if (res.status !== "ok") {
      if (res.status === "reuse") {
        const { tenantId, userId } = res;
        await withTenant(db, tenantId, (tx) =>
          new AuditLogRepository(tx, tenantId).record({
            actorUserId: userId, action: "auth.refresh_reuse_detected", resourceType: "user", resourceId: userId,
            ip: c.get("ip"), requestId: c.get("requestId"), metadata: { familyId: res.familyId },
          }));
      }
      clearAuthCookies(c);
      throw Errors.invalidRefresh();
    }
    const session = await loadSession(res.tenantId, res.userId);
    if (!session) {
      await withTenant(db, res.tenantId, (tx) => new RefreshTokensRepository(tx, res.tenantId).revokeFamily(res.familyId));
      clearAuthCookies(c);
      throw Errors.invalidRefresh();
    }
    setAuthCookies(c, next, expires);
    return c.json(session);
  });

  r.post("/logout", async (c) => {
    checkCsrf(c);
    const old = getCookie(c, REFRESH_COOKIE);
    if (old && old.length <= 256) {
      const who = await preauth.revokeFamilyByHash(sha256(old));
      if (who) {
        await withTenant(db, who.tenantId, (tx) =>
          new AuditLogRepository(tx, who.tenantId).record({
            actorUserId: who.userId, action: "auth.logout", resourceType: "user", resourceId: who.userId, ip: c.get("ip"), requestId: c.get("requestId"),
          }));
      }
    }
    clearAuthCookies(c);
    return c.json({ ok: true as const });
  });

  return r;
}
