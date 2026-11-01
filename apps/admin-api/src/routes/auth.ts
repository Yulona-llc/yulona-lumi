// Admin authentication: password login, TOTP second step, refresh-token session (httpOnly cookie, rotation, revoke),
// password change and TOTP enrolment. Public routes limit themselves; the rest go through the registrar guards.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { decryptJson, encryptJson } from "@yulona/crypto";
import { emailSchema, passwordSchema } from "@yulona/shared";
import type { Deps } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { enforceLimit } from "../middleware";
import { ALL, type AdminEnv, type AdminPrincipal, type Registrar } from "../route";
import { hashPassword, newOpaqueToken, sha256, signAdminToken, verifyAdminToken, verifyPassword } from "../security";
import { newRecoveryCode, newTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from "../totp";

export const CSRF_HEADER = "X-Admin-Request";
const aad = (adminId: string) => `admin-totp:${adminId}`;

interface FoundAdmin { adminId: string; email: string; name: string; passwordHash: string; status: string; lockedUntil: Date | null; role: "owner" | "support" | "billing"; totpEnabled: boolean; mustChangePassword: boolean }

export function registerAuthRoutes(reg: Registrar, d: Deps) {
  const { cfg, db, limiter } = d;
  const sessionMs = cfg.sessionTtlDays * 86_400_000;
  const meOf = (a: AdminPrincipal) => ({ id: a.id, email: a.email, name: a.name, role: a.role, twoFactorEnabled: a.twoFactorEnabled, restricted: a.restricted });
  const audit = (adminId: string | null, action: string, meta: Record<string, unknown> = {}) =>
    db`SELECT sa_audit_event(${adminId}, ${action}, NULL, ${db.json(meta as never)})`;

  function setCookieFor(c: Context<AdminEnv>, token: string, expires: Date) {
    setCookie(c, cfg.cookieName, token, { httpOnly: true, secure: cfg.cookieSecure, sameSite: "Strict", path: "/api/v1/auth", expires });
  }
  const clearCookie = (c: Context<AdminEnv>) => deleteCookie(c, cfg.cookieName, { path: "/api/v1/auth", secure: cfg.cookieSecure, sameSite: "Strict" });
  const needCsrfHeader = (c: Context<AdminEnv>) => { if (c.req.header(CSRF_HEADER) !== "1") throw Errors.csrf(); };

  async function sessionResponse(c: Context<AdminEnv>, a: { adminId: string; email: string; name: string; role: FoundAdmin["role"]; totpEnabled: boolean; mustChangePassword: boolean }, family: string) {
    const accessToken = await signAdminToken(cfg.adminJwtSecret, { sub: a.adminId, typ: "sa", sid: family }, cfg.accessTokenTtlSeconds);
    const restricted: AdminPrincipal["restricted"] = a.mustChangePassword ? "password_change" : cfg.require2fa && !a.totpEnabled ? "two_factor_enrolment" : null;
    c.header("Cache-Control", "no-store");
    return c.json({
      accessToken, expiresIn: cfg.accessTokenTtlSeconds,
      admin: { id: a.adminId, email: a.email, name: a.name, role: a.role, twoFactorEnabled: a.totpEnabled, restricted },
    });
  }
  async function startSession(c: Context<AdminEnv>, a: FoundAdmin) {
    const refresh = newOpaqueToken(32);
    const expires = new Date(Date.now() + sessionMs);
    const [row] = await db<{ saAdminSessionCreate: string }[]>`
      SELECT sa_admin_session_create(${a.adminId}, ${sha256(refresh)}, ${expires}, ${c.get("ip")}, ${c.req.header("user-agent") ?? null})`;
    setCookieFor(c, refresh, expires);
    await audit(a.adminId, "admin.login", { ip: c.get("ip") });
    return sessionResponse(c, a, row!.saAdminSessionCreate);
  }

  // ---------------------------------------------------------------- login
  reg.route({ method: "POST", path: "/auth/login", roles: "public", tag: "Auth", summary: "Password login; returns a session or a 2FA challenge",
    body: z.strictObject({ email: emailSchema, password: z.string().min(1).max(128) }) }, async (c) => {
    const ip = c.get("ip");
    await enforceLimit(limiter, `adm:login:ip:${ip}`, cfg.rateLimits.loginIp);
    const body = await parseBody(c, z.strictObject({ email: emailSchema, password: z.string().min(1).max(128) }));
    await enforceLimit(limiter, `adm:login:${ip}:${body.email}`, cfg.rateLimits.loginIpEmail);
    const [a] = await db<FoundAdmin[]>`SELECT * FROM sa_find_admin_v2(${body.email})`;
    const ok = await verifyPassword(body.password, a?.passwordHash);
    const locked = !!a?.lockedUntil && a.lockedUntil.getTime() > Date.now();
    if (!a || a.status !== "active" || locked || !ok) {
      if (a && a.status === "active" && !locked) {
        await db`SELECT sa_record_login(${a.adminId}, false)`;
        await audit(a.adminId, "admin.login_failed", { ip });
      }
      throw Errors.invalidCredentials();
    }
    if (a.totpEnabled) {
      const challengeToken = await signAdminToken(cfg.adminJwtSecret, { sub: a.adminId, typ: "sa2fa" }, 300);
      return c.json({ twoFactorRequired: true as const, challengeToken, expiresIn: 300 });
    }
    await db`SELECT sa_record_login(${a.adminId}, true)`;
    return startSession(c, a);
  });

  reg.route({ method: "POST", path: "/auth/login/2fa", roles: "public", tag: "Auth", summary: "Second login step: TOTP code or recovery code",
    body: z.strictObject({ challengeToken: z.string().min(10).max(2000), code: z.string().optional(), recoveryCode: z.string().optional() }) }, async (c) => {
    const ip = c.get("ip");
    await enforceLimit(limiter, `adm:2fa:ip:${ip}`, cfg.rateLimits.twoFactor);
    const body = await parseBody(c, z.strictObject({
      challengeToken: z.string().min(10).max(2000), code: z.string().trim().regex(/^\d{6}$/).optional(), recoveryCode: z.string().trim().min(6).max(40).optional(),
    }).refine((b) => !!b.code !== !!b.recoveryCode, "Send exactly one of code or recoveryCode"));
    const claims = await verifyAdminToken(cfg.adminJwtSecret, body.challengeToken, "sa2fa");
    if (!claims) throw Errors.invalidCredentials();
    await enforceLimit(limiter, `adm:2fa:${claims.sub}`, cfg.rateLimits.twoFactor);
    const [a] = await db<FoundAdmin[]>`SELECT * FROM sa_find_admin_v2((SELECT email FROM sa_admin_get(${claims.sub})))`;
    const locked = !!a?.lockedUntil && a.lockedUntil.getTime() > Date.now();
    if (!a || a.status !== "active" || locked || !a.totpEnabled) throw Errors.invalidCredentials();
    const good = await secondFactorOk(a.adminId, body.code, body.recoveryCode);
    if (!good) {
      await db`SELECT sa_record_login(${a.adminId}, false)`;
      await audit(a.adminId, "admin.login_failed", { ip, step: "2fa" });
      throw Errors.invalidCredentials();
    }
    await db`SELECT sa_record_login(${a.adminId}, true)`;
    return startSession(c, a);
  });

  async function secondFactorOk(adminId: string, code?: string, recoveryCode?: string): Promise<boolean> {
    if (!cfg.encryptionKey) throw Errors.unavailable("ENCRYPTION_KEY is not configured; two-factor authentication is unavailable");
    if (recoveryCode) {
      const [r] = await db<{ saAdminUseRecovery: boolean }[]>`SELECT sa_admin_use_recovery(${adminId}, ${sha256(normalizeRecoveryCode(recoveryCode))})`;
      return !!r?.saAdminUseRecovery;
    }
    const [st] = await db<{ secretEncrypted: string | null }[]>`SELECT * FROM sa_admin_totp_state(${adminId})`;
    if (!st?.secretEncrypted) return false;
    let secret: string;
    try { secret = decryptJson<{ secret: string }>(cfg.encryptionKey, st.secretEncrypted, aad(adminId)).secret; } catch { return false; }
    const step = verifyTotp(secret, code ?? "");
    if (step === null) return false;
    const [acc] = await db<{ saAdminTotpAccept: boolean }[]>`SELECT sa_admin_totp_accept(${adminId}, ${step})`;
    return !!acc?.saAdminTotpAccept;
  }

  // ---------------------------------------------------------------- refresh / logout (cookie realm)
  reg.route({ method: "POST", path: "/auth/refresh", roles: "public", tag: "Auth", summary: "Rotate the refresh cookie and return a new session (header X-Admin-Request: 1)" }, async (c) => {
    needCsrfHeader(c);
    await enforceLimit(limiter, `adm:refresh:ip:${c.get("ip")}`, { limit: 60, windowMs: 60_000 });
    const old = getCookie(c, cfg.cookieName);
    if (!old) throw Errors.invalidRefresh();
    const next = newOpaqueToken(32);
    const expires = new Date(Date.now() + sessionMs);
    const [r] = await db<{ rStatus: string; rAdmin: string | null; rFamily: string | null }[]>`
      SELECT * FROM sa_admin_session_rotate(${sha256(old)}, ${sha256(next)}, ${expires}, ${c.get("ip")}, ${c.req.header("user-agent") ?? null})`;
    if (!r || r.rStatus !== "ok") { clearCookie(c); throw Errors.invalidRefresh(); }
    const [a] = await db<FoundAdmin[]>`SELECT * FROM sa_find_admin_v2((SELECT email FROM sa_admin_get(${r.rAdmin!})))`;
    if (!a || a.status !== "active") { clearCookie(c); throw Errors.invalidRefresh(); }
    setCookieFor(c, next, expires);
    return sessionResponse(c, a, r.rFamily!);
  });

  reg.route({ method: "POST", path: "/auth/logout", roles: "public", tag: "Auth", summary: "Revoke the session and clear the cookie (header X-Admin-Request: 1)" }, async (c) => {
    needCsrfHeader(c);
    const old = getCookie(c, cfg.cookieName);
    if (old) {
      const [f] = await db<{ saAdminSessionFamilyOf: string | null }[]>`SELECT sa_admin_session_family_of(${sha256(old)})`;
      if (f?.saAdminSessionFamilyOf) await db`SELECT sa_admin_session_revoke(${f.saAdminSessionFamilyOf})`;
    }
    clearCookie(c);
    return c.json({ ok: true as const });
  });

  // ---------------------------------------------------------------- me, password, 2FA (authenticated, allowed while restricted)
  reg.route({ method: "GET", path: "/auth/me", roles: ALL, tag: "Auth", summary: "Current admin", allowRestricted: true }, (c) => c.json(meOf(c.get("admin"))));

  const pw = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });
  reg.route({ method: "POST", path: "/auth/password", roles: ALL, tag: "Auth", summary: "Change the password (revokes all other sessions)", allowRestricted: true, body: pw }, async (c) => {
    const me = c.get("admin");
    const body = await parseBody(c, pw);
    const [a] = await db<FoundAdmin[]>`SELECT * FROM sa_find_admin_v2(${me.email})`;
    if (!a || !(await verifyPassword(body.currentPassword, a.passwordHash))) throw Errors.invalidCredentials();
    if (body.newPassword === body.currentPassword) throw Errors.validation([{ path: "newPassword", message: "Must differ from the current password" }]);
    await db`SELECT sa_admin_set_password(${me.id}, ${await hashPassword(body.newPassword)}, false)`;
    await db`SELECT sa_admin_sessions_revoke_all(${me.id}, ${me.sessionId})`;
    return c.json({ ok: true as const });
  });

  const needKey = () => { if (!cfg.encryptionKey) throw Errors.unavailable("ENCRYPTION_KEY is not configured; two-factor authentication is unavailable"); return cfg.encryptionKey; };
  const confirmPassword = async (c: Context<AdminEnv>, password: string) => {
    const [a] = await db<FoundAdmin[]>`SELECT * FROM sa_find_admin_v2(${c.get("admin").email})`;
    if (!a || !(await verifyPassword(password, a.passwordHash))) throw Errors.invalidCredentials();
  };

  const setupBody = z.strictObject({ password: z.string().min(1).max(128) });
  reg.route({ method: "POST", path: "/auth/2fa/setup", roles: ALL, tag: "Auth", summary: "Start TOTP enrolment: returns the secret and otpauth URL", allowRestricted: true, body: setupBody }, async (c) => {
    const me = c.get("admin");
    const key = needKey();
    const body = await parseBody(c, setupBody);
    await confirmPassword(c, body.password);
    if (me.twoFactorEnabled) throw Errors.conflict("Two-factor authentication is already enabled");
    const secret = newTotpSecret();
    await db`SELECT sa_admin_totp_set_pending(${me.id}, ${encryptJson(key, { secret }, aad(me.id))})`;
    return c.json({ secret, otpauthUrl: otpauthUrl(secret, me.email) });
  });

  const confirmBody = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });
  reg.route({ method: "POST", path: "/auth/2fa/confirm", roles: ALL, tag: "Auth", summary: "Confirm enrolment with a code; returns 10 recovery codes once", allowRestricted: true, body: confirmBody }, async (c) => {
    const me = c.get("admin");
    const key = needKey();
    await enforceLimit(limiter, `adm:2fa:${me.id}`, cfg.rateLimits.twoFactor);
    const body = await parseBody(c, confirmBody);
    const [st] = await db<{ pendingEncrypted: string | null; enabled: boolean }[]>`SELECT * FROM sa_admin_totp_state(${me.id})`;
    if (!st || st.enabled) throw Errors.conflict("Two-factor authentication is already enabled");
    if (!st.pendingEncrypted) throw Errors.conflict("Start the setup first");
    let secret: string;
    try { secret = decryptJson<{ secret: string }>(key, st.pendingEncrypted, aad(me.id)).secret; } catch { throw Errors.conflict("Start the setup again"); }
    const step = verifyTotp(secret, body.code);
    if (step === null) throw Errors.validation([{ path: "code", message: "Code is not valid" }]);
    const codes = Array.from({ length: 10 }, newRecoveryCode);
    const [ok] = await db<{ saAdminTotpEnable: boolean }[]>`
      SELECT sa_admin_totp_enable(${me.id}, ${db.array(codes.map((x) => sha256(normalizeRecoveryCode(x))))}::text[], ${step})`;
    if (!ok?.saAdminTotpEnable) throw Errors.conflict("Two-factor authentication is already enabled");
    return c.json({ recoveryCodes: codes });
  });

  const disableBody = z.strictObject({ password: z.string().min(1).max(128), code: z.string().trim().regex(/^\d{6}$/).optional(), recoveryCode: z.string().trim().min(6).max(40).optional() })
    .refine((b) => !!b.code !== !!b.recoveryCode, "Send exactly one of code or recoveryCode");
  reg.route({ method: "POST", path: "/auth/2fa/disable", roles: ALL, tag: "Auth", summary: "Disable TOTP (password + code or recovery code)", allowRestricted: true, body: disableBody }, async (c) => {
    const me = c.get("admin");
    if (cfg.require2fa) throw Errors.forbidden("Two-factor authentication is required for all admins");
    await enforceLimit(limiter, `adm:2fa:${me.id}`, cfg.rateLimits.twoFactor);
    const body = await parseBody(c, disableBody);
    await confirmPassword(c, body.password);
    if (!me.twoFactorEnabled) throw Errors.conflict("Two-factor authentication is not enabled");
    if (!(await secondFactorOk(me.id, body.code, body.recoveryCode))) throw Errors.invalidCredentials();
    await db`SELECT sa_admin_totp_disable(${me.id})`;
    return c.json({ ok: true as const });
  });
}
