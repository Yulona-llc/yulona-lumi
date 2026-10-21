import { ProviderError, type CalendarEventInput, type TimeSlot } from "@yulona/providers";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Overridable for tests (mock HTTP server). */
  authUrl?: string;
  tokenUrl?: string;
  apiBase?: string;
  revokeUrl?: string;
}
export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.readonly",
];

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Thin Google Calendar REST client. All calls accept an AbortSignal so callers can enforce timeouts. */
export class GoogleCalendarClient {
  private readonly authUrl: string;
  private readonly tokenUrl: string;
  private readonly apiBase: string;
  private readonly revokeUrl: string;
  constructor(private readonly cfg: GoogleOAuthConfig, private readonly fetchImpl: FetchLike = fetch) {
    this.authUrl = cfg.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
    this.tokenUrl = cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.apiBase = (cfg.apiBase ?? "https://www.googleapis.com/calendar/v3").replace(/\/+$/, "");
    this.revokeUrl = cfg.revokeUrl ?? "https://oauth2.googleapis.com/revoke";
  }

  authorizeUrl(state: string): string {
    const u = new URL(this.authUrl);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async tokenRequest(params: Record<string, string>, signal?: AbortSignal) {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }).toString(),
      signal,
    });
    if (!res.ok) throw new ProviderError(`google token endpoint HTTP ${res.status}`, "google", res.status >= 500 || res.status === 429, res.status);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  }

  async exchangeCode(code: string, signal?: AbortSignal): Promise<GoogleTokens> {
    const j = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri }, signal);
    if (!j.refresh_token) throw new ProviderError("google did not return a refresh token (re-consent required)", "google", false);
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
  }

  async refresh(refreshToken: string, signal?: AbortSignal): Promise<GoogleTokens> {
    const j = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, signal);
    return { accessToken: j.access_token, refreshToken: j.refresh_token ?? refreshToken, expiresAt: Date.now() + j.expires_in * 1000 };
  }

  async revoke(token: string): Promise<void> {
    await this.fetchImpl(`${this.revokeUrl}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
  }

  private async api<T>(accessToken: string, path: string, init: RequestInit & { signal?: AbortSignal }): Promise<T | null> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new ProviderError(`google calendar HTTP ${res.status}`, "google", res.status >= 500 || res.status === 429, res.status);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  async calendarEmail(accessToken: string, calendarId: string, signal?: AbortSignal): Promise<string | null> {
    const r = await this.api<{ id?: string }>(accessToken, `/calendars/${encodeURIComponent(calendarId)}`, { method: "GET", signal });
    return r?.id?.includes("@") ? r.id : null;
  }

  async freeBusy(accessToken: string, calendarId: string, from: string, to: string, signal?: AbortSignal): Promise<TimeSlot[]> {
    const r = await this.api<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(accessToken, "/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: from, timeMax: to, items: [{ id: calendarId }] }),
      signal,
    });
    return (r?.calendars?.[calendarId]?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
  }

  async insertEvent(accessToken: string, calendarId: string, e: CalendarEventInput, signal?: AbortSignal): Promise<{ id: string; url?: string }> {
    const r = await this.api<{ id: string; htmlLink?: string }>(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`, {
      method: "POST",
      body: JSON.stringify({
        summary: e.title,
        description: e.description,
        start: { dateTime: e.start, timeZone: e.timezone },
        end: { dateTime: e.end, timeZone: e.timezone },
        attendees: e.attendeeEmail ? [{ email: e.attendeeEmail }] : undefined,
      }),
      signal,
    });
    if (!r?.id) throw new ProviderError("google returned no event id", "google", true);
    return { id: r.id, url: r.htmlLink };
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.api(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE", signal });
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 404 || e.status === 410)) return; // already gone
      throw e;
    }
  }
}

/** Free slots inside [from, to): a `step`-aligned grid of `durationMin` windows that do not overlap a busy period. */
export function computeSlots(
  from: Date, to: Date, durationMin: number, busy: TimeSlot[], opts: { stepMin?: number; notBefore?: Date; max?: number } = {},
): TimeSlot[] {
  const step = (opts.stepMin ?? 30) * 60_000;
  const dur = durationMin * 60_000;
  const notBefore = (opts.notBefore ?? new Date()).getTime();
  const intervals = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const).filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e));
  const out: TimeSlot[] = [];
  for (let t = Math.ceil(Math.max(from.getTime(), notBefore) / step) * step; t + dur <= to.getTime(); t += step) {
    if (intervals.some(([s, e]) => t < e && t + dur > s)) continue;
    out.push({ start: new Date(t).toISOString(), end: new Date(t + dur).toISOString() });
    if (out.length >= (opts.max ?? 200)) break;
  }
  return out;
}
