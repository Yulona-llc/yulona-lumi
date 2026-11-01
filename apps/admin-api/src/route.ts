// Declarative route registration: every route states its roles once; the same table drives the guards,
// the OpenAPI export and the role-matrix tests.
import type { Context } from "hono";
import type { z } from "zod";

export const ADMIN_ROLES = ["owner", "support", "billing"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export type Restriction = "password_change" | "two_factor_enrolment";

export interface AdminPrincipal {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  twoFactorEnabled: boolean;
  restricted: Restriction | null;
  sessionId: string;
}
export type AdminEnv = { Variables: { requestId: string; ip: string; admin: AdminPrincipal } };
export type Handler = (c: Context<AdminEnv>) => Response | Promise<Response>;

export interface RouteMeta {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Hono path relative to /api/v1, e.g. "/tenants/:id" */
  path: string;
  /** allowed roles; "public" = no access token (login, refresh cookie realm) */
  roles: readonly AdminRole[] | "public";
  summary: string;
  tag: string;
  /** counts against the write limit (default: every method but GET; exports set it) */
  write?: boolean;
  /** reachable while the session is restricted (password change / 2FA enrolment) */
  allowRestricted?: boolean;
  body?: z.ZodType;
  query?: z.ZodType;
  /** non-JSON success response */
  contentType?: string;
  status?: number;
}
export interface Registrar {
  route(meta: RouteMeta, handler: Handler): void;
}

export const ALL: readonly AdminRole[] = ADMIN_ROLES;
export const OWNER: readonly AdminRole[] = ["owner"];
export const OWNER_SUPPORT: readonly AdminRole[] = ["owner", "support"];
export const OWNER_BILLING: readonly AdminRole[] = ["owner", "billing"];

export const isWrite = (m: RouteMeta) => m.write ?? m.method !== "GET";
