import { createHash, createHmac } from "node:crypto";
import { ProviderError, type CalendarEventInput, type TimeSlot } from "@yulona/providers";

/**
 * Calendly API v2 client (verified against developer.calendly.com, see docs/api/ops.md "Calendly").
 * OAuth: authorize at auth.calendly.com/oauth/authorize, token/refresh at auth.calendly.com/oauth/token (HTTP Basic client auth),
 * access tokens last 2 h and refresh tokens ROTATE (single use). Scopes are fixed on the OAuth app registration, not sent in the URL.
 */
export interface CalendlyOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Overridable for tests (mock HTTP server). */
  authUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  apiBase?: string;
}
export interface CalendlyTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  /** Calendly user URI that owns the token. */
  owner?: string;
}
export interface CalendlyEventType { uri: string; name: string; duration: number; active: boolean; schedulingUrl: string | null; kind: string | null; poolingType: string | null }

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Deterministic PKCE verifier derived from the signed state (no server-side storage; unguessable without the server secret). */
export const pkceVerifier = (secret: string, state: string) => createHmac("sha256", `pkce:${secret}`).update(state).digest("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const uuidOf = (uri: string) => uri.replace(/\/+$/, "").split("/").pop() ?? uri;

export class CalendlyClient {
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly apiBase: string;
  constructor(readonly cfg: CalendlyOAuthConfig, private readonly fetchImpl: FetchLike = fetch) {
    this.authUrl = cfg.authUrl ?? "https://auth.calendly.com/oauth/authorize";
    this.tokenUrl = cfg.tokenUrl ?? "https://auth.calendly.com/oauth/token";
    this.revokeUrl = cfg.revokeUrl ?? "https://auth.calendly.com/oauth/revoke";
    this.apiBase = (cfg.apiBase ?? "https://api.calendly.com").replace(/\/+$/, "");
  }

  authorizeUrl(state: string, verifier: string): string {
    const u = new URL(this.authUrl);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("code_challenge", pkceChallenge(verifier));
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async tokenRequest(params: Record<string, string>, signal?: AbortSignal): Promise<CalendlyTokens> {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(params).toString(),
      signal,
    });
    // 429 (8 tokens/user/min) and 5xx are transient; 400/401 (invalid_grant, revoked) are permanent => reconnect.
    if (!res.ok) throw new ProviderError(`calendly token endpoint HTTP ${res.status}`, "calendly", res.status >= 500 || res.status === 429, res.status);
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; created_at?: number; owner?: string };
    if (!j.access_token || !j.refresh_token) throw new ProviderError("calendly token response incomplete", "calendly", false);
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000, owner: j.owner };
  }
  exchangeCode(code: string, verifier: string, signal?: AbortSignal) {
    return this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier }, signal);
  }
  refresh(refreshToken: string, prevOwner?: string, signal?: AbortSignal) {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, signal).then((t) => ({ ...t, owner: t.owner ?? prevOwner }));
  }
  async revoke(token: string): Promise<void> {
    await this.fetchImpl(this.revokeUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, token }).toString(),
    }).catch(() => undefined);
  }

  /** Authenticated JSON call; maps HTTP errors to ProviderError (retryable on 5xx/429). */
  async api<T>(accessToken: string, method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const u = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);
    const res = await this.fetchImpl(u.toString(), {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok) throw new ProviderError(`calendly HTTP ${res.status}`, "calendly", res.status >= 500 || res.status === 429, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async me(accessToken: string, signal?: AbortSignal): Promise<{ uri: string; email: string | null; name: string | null; timezone: string | null }> {
    const r = await this.api<{ resource: { uri: string; email?: string; name?: string; timezone?: string } }>(accessToken, "GET", "/users/me", { signal });
    return { uri: r.resource.uri, email: r.resource.email ?? null, name: r.resource.name ?? null, timezone: r.resource.timezone ?? null };
  }

  async listEventTypes(accessToken: string, userUri: string, signal?: AbortSignal): Promise<CalendlyEventType[]> {
    const r = await this.api<{ collection: { uri: string; name: string | null; duration: number; active: boolean; scheduling_url?: string; kind?: string; pooling_type?: string | null }[] }>(
      accessToken, "GET", "/event_types", { query: { user: userUri, active: "true", count: "50" }, signal });
    return (r.collection ?? []).map((e) => ({ uri: e.uri, name: e.name ?? "Untitled", duration: e.duration, active: e.active, schedulingUrl: e.scheduling_url ?? null, kind: e.kind ?? null, poolingType: e.pooling_type ?? null }));
  }
  async getEventType(accessToken: string, uri: string, signal?: AbortSignal) {
    const r = await this.api<{ resource: { uri: string; name: string | null; duration: number; active: boolean } }>(accessToken, "GET", `/event_types/${encodeURIComponent(uuidOf(uri))}`, { signal });
    return r.resource;
  }
  /** GET /event_type_available_times: start_time must be in the future, end_time at most 31 days after start_time. */
  async availableTimes(accessToken: string, eventTypeUri: string, from: Date, to: Date, signal?: AbortSignal): Promise<string[]> {
    const r = await this.api<{ collection: { status: string; start_time: string }[] }>(accessToken, "GET", "/event_type_available_times", {
      query: { event_type: eventTypeUri, start_time: from.toISOString(), end_time: to.toISOString() }, signal });
    return (r.collection ?? []).filter((s) => s.status === "available").map((s) => s.start_time);
  }
  /** Scheduling API (paid Calendly plans only; Free => 403). */
  async createInvitee(accessToken: string, b: { eventTypeUri: string; start: string; name: string; email: string; timezone: string }, signal?: AbortSignal) {
    const r = await this.api<{ resource: { uri: string; event: string; reschedule_url?: string; cancel_url?: string } }>(accessToken, "POST", "/invitees", {
      body: { event_type: b.eventTypeUri, start_time: b.start, invitee: { name: b.name, email: b.email, timezone: b.timezone } }, signal });
    return { inviteeUri: r.resource.uri, eventUri: r.resource.event, url: r.resource.reschedule_url ?? r.resource.cancel_url };
  }
  async createSchedulingLink(accessToken: string, eventTypeUri: string, signal?: AbortSignal): Promise<string> {
    const r = await this.api<{ resource: { booking_url: string } }>(accessToken, "POST", "/scheduling_links", {
      body: { max_event_count: 1, owner: eventTypeUri, owner_type: "EventType" }, signal });
    return r.resource.booking_url;
  }
  async cancelEvent(accessToken: string, eventUuid: string, reason: string | undefined, signal?: AbortSignal): Promise<void> {
    await this.api(accessToken, "POST", `/scheduled_events/${encodeURIComponent(eventUuid)}/cancellation`, { body: reason ? { reason: reason.slice(0, 1000) } : {}, signal });
  }
}

export type { CalendarEventInput, TimeSlot };
