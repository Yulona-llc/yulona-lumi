import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import {
  CalendlyClient, CalendlyOAuthError, checkRedirectUri, loadTenantCalendarAny, TenantCalendlyCalendar, openCalendlyTokens, pkceVerifier, sealCalendlyTokens, signState, verifyState, withRetry,
} from "@yulona/ops";
import { setCalendlyEventTypeSchema, setDefaultCalendarSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { audit } from "../platform/util";
import { guard, iso, type OpsDeps } from "./common";

const retryable = (e: unknown) => {
  const s = (e as { status?: number }).status;
  return s === undefined || s >= 500 || s === 429;
};
interface ConnRow { provider: string; accountEmail: string | null; calendarId: string; status: string; lastError: string | null; isDefault: boolean; createdAt: Date }

/** Calendly OAuth ("Connect Calendly"), event-type selection, and the per-tenant default calendar. Admin+ only; tenant from auth/signed state. */
export function calendlyRoutes(deps: OpsDeps) {
  const { cfg, db, runtime } = deps;
  const r = new Hono<AppEnv>();
  const calendly = () => (runtime.calendly ? new CalendlyClient(runtime.calendly, runtime.fetchImpl) : null);
  const notConfigured = () => new AppError(503, "service_unavailable", "Calendly is not configured (CALENDLY_CLIENT_ID/SECRET, ENCRYPTION_KEY)");

  /** Effective redirect URI (exactly what is sent to Calendly), where it came from and the pre-flight verdict. */
  const redirectInfo = () => {
    if (!runtime.calendly) return null;
    const uri = runtime.calendly.redirectUri;
    const source = runtime.calendlyRedirectSource ?? "configured";
    const check = checkRedirectUri(uri, source, cfg.isProd);
    return { redirectUri: uri, redirectSource: source, redirectWarning: check.ok ? check.warning : null, redirectError: check.ok ? null : check.message };
  };

  const dto = (x: ConnRow | undefined, provider: string, configured: boolean) => x
    ? { provider, configured, connected: true, accountEmail: x.accountEmail, calendarId: x.calendarId, eventTypeSelected: provider === "calendly" ? x.calendarId.startsWith("http") : true,
        status: x.status, lastError: x.lastError, isDefault: x.isDefault, connectedAt: iso(x.createdAt) }
    : { provider, configured, connected: false };

  /** All providers with their state, plus which one the AI uses. */
  r.get("/calendar/connections", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => tx<ConnRow[]>`
      SELECT provider, account_email, calendar_id, status, last_error, is_default, created_at FROM calendar_connections WHERE tenant_id = ${tenantId}`);
    const items = [
      dto(rows.find((x) => x.provider === "google"), "google", !!runtime.google && !!cfg.encryptionKey),
      { ...dto(rows.find((x) => x.provider === "calendly"), "calendly", !!runtime.calendly && !!cfg.encryptionKey), ...(redirectInfo() ?? {}) },
    ];
    const def = rows.find((x) => x.isDefault)?.provider ?? rows[0]?.provider ?? null;
    return c.json({ items, default: def });
  });

  r.post("/calendar/default", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, setDefaultCalendarSchema);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const [x] = await tx`SELECT 1 FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = ${b.provider}`;
      if (!x) return false;
      await tx`UPDATE calendar_connections SET is_default = false WHERE tenant_id = ${tenantId} AND provider <> ${b.provider}`;
      await tx`UPDATE calendar_connections SET is_default = true, updated_at = now() WHERE tenant_id = ${tenantId} AND provider = ${b.provider}`;
      await audit(tx, c, "calendar.default", "calendar", b.provider);
      return true;
    });
    if (!ok) throw Errors.notFound("That calendar is not connected");
    return c.json({ default: b.provider });
  });

  r.post("/calendar/calendly/connect", guard(cfg, "admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const cl = calendly();
    if (!cl || !cfg.encryptionKey) throw notConfigured();
    const info = redirectInfo()!;
    if (info.redirectError) throw new AppError(400, "validation_error", info.redirectError, { reason: "invalid_redirect_uri", redirectUri: info.redirectUri, redirectSource: info.redirectSource });
    if (info.redirectWarning) deps.log.warn("calendly redirect uri warning", { redirectUri: info.redirectUri, warning: info.redirectWarning });
    const state = signState(cfg.jwtSecret, { tenantId, userId });
    return c.json({ redirectUri: info.redirectUri, warning: info.redirectWarning, url: cl.authorizeUrl(state, pkceVerifier(cfg.jwtSecret, state)) });
  });

  /** Public: Calendly redirects the browser here. Tenant comes from the signed state only (CSRF-safe, 10 min, PKCE bound to it). */
  r.get("/calendar/calendly/callback", async (c) => {
    const back = (q: string, detail?: string) => c.redirect(`${cfg.appUrl.replace(/\/+$/, "")}/settings/integrations?${q}${detail ? `&detail=${encodeURIComponent(detail.replace(/\s+/g, " ").trim().slice(0, 200))}` : ""}`, 302);
    const cl = calendly();
    const rawState = c.req.query("state") ?? "";
    const state = verifyState(cfg.jwtSecret, rawState);
    const code = c.req.query("code");
    if (!cl || !cfg.encryptionKey || !state) return back("calendar=error&provider=calendly&reason=invalid_state");
    const provErr = c.req.query("error");
    if (provErr || !code) {
      // Pass Calendly's own OAuth error through (code is restricted to [a-z_], the description is clipped and shown as plain text).
      const reason = !provErr || provErr === "access_denied" ? "denied" : /^[a-z_]{1,40}$/.test(provErr) ? provErr : "provider_error";
      return back(`calendar=error&provider=calendly&reason=${reason}`, c.req.query("error_description"));
    }
    try {
      const tokens = await withRetry((s) => cl.exchangeCode(code, pkceVerifier(cfg.jwtSecret, rawState), s), { retryable, attempts: 2, ...runtime.calendarRetry });
      const me = await cl.me(tokens.accessToken).catch(() => null);
      if (!me) throw new Error("calendly /users/me failed");
      // Auto-select the first active event type; the admin can change it in settings.
      const types = await cl.listEventTypes(tokens.accessToken, me.uri).catch(() => []);
      const eventType = types.find((t) => t.active && t.poolingType !== "round_robin") ?? types[0];
      const sealed = sealCalendlyTokens(cfg.encryptionKey, state.tenantId, { ...tokens, owner: me.uri });
      await withTenant(db, state.tenantId, async (tx) => {
        await tx`UPDATE calendar_connections SET is_default = false WHERE tenant_id = ${state.tenantId} AND provider <> 'calendly'`;
        await tx`
          INSERT INTO calendar_connections (tenant_id, provider, account_email, calendar_id, credentials_encrypted, status, connected_by, is_default)
          VALUES (${state.tenantId}, 'calendly', ${me.email}, ${eventType?.uri ?? "primary"}, ${sealed}, 'active', ${state.userId}, true)
          ON CONFLICT (tenant_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, calendar_id = EXCLUDED.calendar_id,
            credentials_encrypted = EXCLUDED.credentials_encrypted, status = 'active', last_error = NULL, connected_by = EXCLUDED.connected_by,
            is_default = true, updated_at = now()`;
        await tx`INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, metadata, ip, request_id)
                 VALUES (${state.tenantId}, ${state.userId}, 'calendar.connect', 'calendar', 'calendly', ${tx.json({ accountEmail: me.email } as never)}, ${c.get("ip")}, ${c.get("requestId")})`;
      });
      return back("calendar=connected&provider=calendly");
    } catch (e) {
      deps.log.warn("calendly connect failed", { err: (e as Error).message });
      if (e instanceof CalendlyOAuthError && e.oauthError) {
        const reason = /^[a-z_]{1,40}$/.test(e.oauthError) ? e.oauthError : "exchange_failed";
        return back(`calendar=error&provider=calendly&reason=${reason}`, e.oauthDescription);
      }
      return back("calendar=error&provider=calendly&reason=exchange_failed");
    }
  });

  const requireCal = async (tenantId: string) => {
    const cl = calendly();
    if (!cl || !cfg.encryptionKey) throw notConfigured();
    const cal = await loadTenantCalendarAny({ db, encryptionKey: cfg.encryptionKey, calendly: cl }, tenantId, "calendly");
    if (!(cal instanceof TenantCalendlyCalendar)) throw Errors.notFound("Calendly is not connected");
    return { cl, cal };
  };
  /** Valid access token for the tenant (refreshes through the provider's locked rotation). */
  const withToken = async <T>(tenantId: string, fn: (cl: CalendlyClient, token: string, owner: string | undefined, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const { cl, cal } = await requireCal(tenantId);
    try {
      return await withRetry(async (signal) => {
        const token = await cal.accessToken(signal);
        const [row] = await withTenant(db, tenantId, (tx) => tx<{ credentialsEncrypted: string }[]>`
          SELECT credentials_encrypted FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = 'calendly'`);
        const owner = row ? openCalendlyTokens(cfg.encryptionKey!, tenantId, row.credentialsEncrypted).owner : undefined;
        return fn(cl, token, owner, signal);
      }, { retryable, ...runtime.calendarRetry });
    } catch (e) {
      deps.log.warn("calendly call failed", { tenantId, err: (e as Error).message });
      throw new AppError(503, "service_unavailable", "Calendly is temporarily unavailable");
    }
  };

  r.get("/calendar/calendly/event-types", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const items = await withToken(tenantId, (cl, token, owner, s) => (owner ? cl.listEventTypes(token, owner, s) : Promise.resolve([])));
    const [sel] = await withTenant(db, tenantId, (tx) => tx<{ calendarId: string }[]>`SELECT calendar_id FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = 'calendly'`);
    return c.json({ items: items.map((t) => ({ uri: t.uri, name: t.name, durationMinutes: t.duration, schedulingUrl: t.schedulingUrl, selected: t.uri === sel?.calendarId })) });
  });

  r.patch("/calendar/calendly/event-type", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, setCalendlyEventTypeSchema);
    const { cl } = await requireCal(tenantId);
    if (!b.eventTypeUri.startsWith(`${cl.apiBase}/event_types/`)) throw Errors.validation([{ path: "eventTypeUri", message: "Not a Calendly event type" }]);
    // Ask Calendly: only an event type the connected account can read is accepted.
    const et = await withToken(tenantId, (client, token, _o, s) => client.getEventType(token, b.eventTypeUri, s).catch((e: { status?: number }) => {
      if (e.status === 404 || e.status === 403 || e.status === 400) return null;
      throw e;
    }));
    if (!et || !et.active) throw Errors.validation([{ path: "eventTypeUri", message: "Event type not found or inactive in the connected Calendly account" }]);
    await withTenant(db, tenantId, async (tx) => {
      await tx`UPDATE calendar_connections SET calendar_id = ${b.eventTypeUri}, updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'calendly'`;
      await audit(tx, c, "calendar.update", "calendar", "calendly", { eventType: et.name });
    });
    return c.json({ eventTypeUri: b.eventTypeUri, name: et.name, durationMinutes: et.duration });
  });

  r.delete("/calendar/calendly/connection", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const row = await withTenant(db, tenantId, async (tx) => {
      const [x] = await tx<{ credentialsEncrypted: string; isDefault: boolean }[]>`
        DELETE FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = 'calendly' RETURNING credentials_encrypted, is_default`;
      if (!x) return null;
      // Hand the "default" flag to the remaining connection, if any.
      if (x.isDefault) await tx`UPDATE calendar_connections SET is_default = true WHERE tenant_id = ${tenantId}`;
      await audit(tx, c, "calendar.disconnect", "calendar", "calendly");
      return x;
    });
    if (!row) throw Errors.notFound("Calendly is not connected");
    const cl = calendly();
    if (cl && cfg.encryptionKey) {
      try { await cl.revoke(openCalendlyTokens(cfg.encryptionKey, tenantId, row.credentialsEncrypted).refreshToken); } catch { /* best effort: the row (tokens) is already gone */ }
    }
    return c.json({ ok: true as const });
  });
  return r;
}
