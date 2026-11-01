import type { Context, MiddlewareHandler } from "hono";
import type { Db } from "@yulona/db";
import type { Role, Logger } from "@yulona/shared";
import type { CalendlyOAuthConfig, GoogleOAuthConfig, RedirectSource, RetryOptions } from "@yulona/ops";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { requireAuth } from "../middleware";
import { hasMinRole } from "../platform/authz";
import type { RateLimiter } from "../ratelimit";

/** Runtime options that tests inject (production reads them from env in `opsRuntimeFromEnv`). */
export interface OpsRuntime {
  google?: GoogleOAuthConfig;
  calendly?: CalendlyOAuthConfig;
  /** Where the Calendly redirect URI came from (env resolution); tests that inject `calendly` directly omit it ("configured"). */
  calendlyRedirectSource?: RedirectSource;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  calendarRetry?: RetryOptions;
  /** Tests: fake HubSpot server (production always uses https://api.hubapi.com). */
  hubspot?: { apiBase?: string; retry?: RetryOptions };
}
export interface OpsDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  log: Logger;
  runtime: OpsRuntime;
}

export function opsRuntimeFromEnv(cfg: Config, env: Record<string, string | undefined> = process.env): OpsRuntime {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const base = (cfg.publicApiUrl ?? `http://localhost:${cfg.port}`).replace(/\/+$/, "");
  const calendlySource: RedirectSource = env.CALENDLY_REDIRECT_URI ? "CALENDLY_REDIRECT_URI" : cfg.publicApiUrl ? "PUBLIC_API_URL" : "localhost_fallback";
  return {
    calendlyRedirectSource: calendlySource,
    google: clientId && clientSecret ? { clientId, clientSecret, redirectUri: env.GOOGLE_REDIRECT_URI ?? `${base}/api/v1/calendar/google/callback` } : undefined,
    calendly: env.CALENDLY_CLIENT_ID && env.CALENDLY_CLIENT_SECRET
      ? { clientId: env.CALENDLY_CLIENT_ID, clientSecret: env.CALENDLY_CLIENT_SECRET, redirectUri: env.CALENDLY_REDIRECT_URI || `${base}/api/v1/calendar/calendly/callback` }
      : undefined,
  };
}

/** Auth + minimum role for ONE route (no `use("*")`: Hono hoists those onto later routers). */
export const guard = (cfg: Config, min: Role): MiddlewareHandler<AppEnv> => {
  const auth = requireAuth(cfg);
  return async (c, next) => {
    await auth(c, async () => {});
    if (!hasMinRole(c.get("auth").role, min)) throw Errors.forbidden("Insufficient role");
    await next();
  };
};

// ---- cursors: base64url("<iso-us>|<uuid>") ---------------------------------------------------------
export const encodeCur = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString("base64url");
export function decodeCur(raw: string | undefined): { ts: string; id: string } | null {
  if (raw === undefined) return null;
  const [ts, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/i.test(id)) throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
  return { ts, id };
}
/** SQL fragment text for a microsecond-precise ISO timestamp (JS Dates would truncate and break keyset paging). */
export const TS_FMT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

export const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export const clientIp = (c: Context<AppEnv>) => c.get("ip");
