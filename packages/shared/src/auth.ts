import { z } from "zod";
import { roleSchema } from "./roles";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const passwordSchema = z.string().min(12, "Password must be at least 12 characters").max(128);
const displayName = z.string().trim().min(1).max(100);

/** POST /api/v1/auth/register. tenantId is never accepted from clients. */
export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: displayName,
  workspaceName: displayName,
});
export type RegisterInput = z.input<typeof registerSchema>;

/** POST /api/v1/auth/login */
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.input<typeof loginSchema>;

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
});
export type User = z.infer<typeof userSchema>;

export const tenantSchema = z.object({ id: z.uuid(), name: z.string() });
export type Tenant = z.infer<typeof tenantSchema>;

/** Returned by register / login / refresh. Refresh token lives only in the `yl_rt` cookie. */
export const sessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: userSchema,
  tenant: tenantSchema,
});
export type Session = z.infer<typeof sessionSchema>;

/** GET /api/v1/me */
export const meSchema = z.object({ user: userSchema, tenant: tenantSchema });
export type Me = z.infer<typeof meSchema>;

/** Logout response */
export const okSchema = z.object({ ok: z.literal(true) });

/** Access JWT claims: sub, tid, role, iat, exp, jti */
export const accessClaimsSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid(),
  role: roleSchema,
  iat: z.number(),
  exp: z.number(),
  jti: z.string(),
  /** Present only on impersonation tokens: platform admin id + impersonation session id. */
  imp: z.uuid().optional(),
  ims: z.uuid().optional(),
  /** Read-only impersonation (platform support): the API rejects every non-GET/HEAD request. */
  ro: z.boolean().optional(),
});
export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_COOKIE = "yl_rt";
export const CSRF_COOKIE = "yl_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
