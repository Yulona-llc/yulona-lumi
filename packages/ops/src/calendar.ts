import { withTenant, type Db } from "@yulona/db";
import type { CalendarProvider, CalendarEventInput, TimeSlot } from "@yulona/providers";
import { ProviderError } from "@yulona/providers";
import { decryptJson, encryptJson } from "./crypto";
import { type CalendlyClient, type CalendlyTokens, uuidOf } from "./calendly";
import { computeSlots, GoogleCalendarClient, type GoogleTokens } from "./google";

export interface CalendarDeps {
  db: Db;
  encryptionKey: string;
  google: GoogleCalendarClient;
}

interface Conn {
  calendarId: string;
  credentialsEncrypted: string;
}

const aad = (tenantId: string) => `calendar:${tenantId}:google`;
export const sealTokens = (key: string, tenantId: string, t: GoogleTokens) => encryptJson(key, { ...t }, aad(tenantId));
export const openTokens = (key: string, tenantId: string, env: string) => decryptJson<GoogleTokens>(key, env, aad(tenantId));

/** Tenant-scoped Google `CalendarProvider`; refreshes and re-encrypts tokens transparently. */
export class TenantGoogleCalendar implements CalendarProvider {
  readonly name = "google";
  private tokens: GoogleTokens;
  constructor(private readonly d: CalendarDeps, private readonly tenantId: string, private readonly conn: Conn) {
    this.tokens = openTokens(d.encryptionKey, tenantId, conn.credentialsEncrypted);
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.tokens.expiresAt - 60_000 > Date.now()) return this.tokens.accessToken;
    try {
      this.tokens = await this.d.google.refresh(this.tokens.refreshToken, signal);
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) await this.markError("token refresh failed (reconnect the calendar)");
      throw e;
    }
    await withTenant(this.d.db, this.tenantId, (tx) => tx`
      UPDATE calendar_connections SET credentials_encrypted = ${sealTokens(this.d.encryptionKey, this.tenantId, this.tokens)},
        status = 'active', last_error = NULL, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND provider = 'google'`);
    return this.tokens.accessToken;
  }

  private markError(msg: string) {
    return withTenant(this.d.db, this.tenantId, (tx) => tx`
      UPDATE calendar_connections SET status = 'error', last_error = ${msg}, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND provider = 'google'`);
  }

  /** `signal` is optional so the class stays a drop-in `CalendarProvider`; ops code passes it via `withRetry`. */
  async availability(q: { from: string; to: string; durationMinutes: number; timezone?: string }, signal?: AbortSignal): Promise<TimeSlot[]> {
    const token = await this.accessToken(signal);
    const busy = await this.d.google.freeBusy(token, this.conn.calendarId, q.from, q.to, signal);
    const raw = computeSlots(new Date(q.from), new Date(q.to), q.durationMinutes, busy, { max: 600 });
    if (!raw.length) return [];
    // Keep only slots fully inside business hours (no configured hours => always open).
    const starts = raw.map((s) => s.start);
    const ends = raw.map((s) => new Date(Date.parse(s.end) - 60_000).toISOString());
    const rows = await withTenant(this.d.db, this.tenantId, (tx) => tx<{ ord: number; ok: boolean }[]>`
      SELECT ord::int AS ord, (ops_in_business_hours(${this.tenantId}::uuid, s) AND ops_in_business_hours(${this.tenantId}::uuid, e)) AS ok
      FROM unnest(${tx.array(starts)}::timestamptz[], ${tx.array(ends)}::timestamptz[]) WITH ORDINALITY AS t(s, e, ord)`);
    const ok = new Set(rows.filter((r) => r.ok).map((r) => r.ord - 1));
    return raw.filter((_, i) => ok.has(i)).slice(0, 200);
  }

  async createEvent(e: CalendarEventInput, signal?: AbortSignal): Promise<{ id: string; url?: string }> {
    return this.d.google.insertEvent(await this.accessToken(signal), this.conn.calendarId, e, signal);
  }

  async cancelEvent(id: string, signal?: AbortSignal): Promise<void> {
    await this.d.google.deleteEvent(await this.accessToken(signal), this.conn.calendarId, id, signal);
  }
}

/** Load the tenant's calendar provider, or null when no (healthy) connection exists. */
export async function loadTenantCalendar(d: CalendarDeps, tenantId: string): Promise<TenantGoogleCalendar | null> {
  const [conn] = await withTenant(d.db, tenantId, (tx) => tx<Conn[]>`
    SELECT calendar_id, credentials_encrypted FROM calendar_connections WHERE tenant_id = ${tenantId} AND provider = 'google'`);
  return conn ? new TenantGoogleCalendar(d, tenantId, conn) : null;
}

// ---- Calendly ---------------------------------------------------------------------------------------
export interface AnyCalendarDeps {
  db: Db;
  encryptionKey: string;
  google?: GoogleCalendarClient | null;
  calendly?: CalendlyClient | null;
}
const calendlyAad = (tenantId: string) => `calendar:${tenantId}:calendly`;
export const sealCalendlyTokens = (key: string, tenantId: string, t: CalendlyTokens) => encryptJson(key, { ...t }, calendlyAad(tenantId));
export const openCalendlyTokens = (key: string, tenantId: string, env: string) => decryptJson<CalendlyTokens>(key, env, calendlyAad(tenantId));

const permanent = (msg: string, status?: number) => new ProviderError(msg, "calendly", false, status);

/**
 * Tenant-scoped Calendly provider. `conn.calendarId` is the chosen event type URI.
 * Availability uses `event_type_available_times`; booking uses the Scheduling API (paid plans) and falls back to a
 * single-use scheduling link (`offered: true`) when Calendly answers 403 (Free plan) or the invitee e-mail is unknown.
 */
export class TenantCalendlyCalendar implements CalendarProvider {
  readonly name = "calendly";
  private tokens: CalendlyTokens;
  private duration: number | null = null;
  constructor(private readonly d: { db: Db; encryptionKey: string; calendly: CalendlyClient }, private readonly tenantId: string, private readonly conn: Conn) {
    this.tokens = openCalendlyTokens(d.encryptionKey, tenantId, conn.credentialsEncrypted);
  }

  private get eventType(): string {
    if (!this.conn.calendarId.startsWith(`${this.d.calendly.apiBase}/event_types/`)) {
      throw permanent("calendly event type not selected (choose one in Calendar settings)");
    }
    return this.conn.calendarId;
  }

  private async markError(msg: string) {
    await withTenant(this.d.db, this.tenantId, (tx) => tx`
      UPDATE calendar_connections SET status = 'error', last_error = ${msg}, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND provider = 'calendly'`);
  }

  /** Refresh tokens rotate (single use): serialise refreshes per tenant with a row lock and re-read before spending the token. */
  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.tokens.expiresAt - 60_000 > Date.now()) return this.tokens.accessToken;
    try {
      this.tokens = await withTenant(this.d.db, this.tenantId, async (tx) => {
        const [row] = await tx<{ credentialsEncrypted: string }[]>`
          SELECT credentials_encrypted FROM calendar_connections WHERE tenant_id = ${this.tenantId} AND provider = 'calendly' FOR UPDATE`;
        if (!row) throw permanent("calendly is not connected");
        const cur = openCalendlyTokens(this.d.encryptionKey, this.tenantId, row.credentialsEncrypted);
        if (cur.expiresAt - 60_000 > Date.now()) return cur; // another worker refreshed already
        const next = await this.d.calendly.refresh(cur.refreshToken, cur.owner, signal);
        await tx`UPDATE calendar_connections SET credentials_encrypted = ${sealCalendlyTokens(this.d.encryptionKey, this.tenantId, next)},
          status = 'active', last_error = NULL, updated_at = now() WHERE tenant_id = ${this.tenantId} AND provider = 'calendly'`;
        return next;
      });
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) await this.markError("token refresh failed (reconnect Calendly)");
      throw e;
    }
    return this.tokens.accessToken;
  }

  /** The event type's fixed length: Calendly, not the caller, decides how long a meeting is. */
  async eventDuration(signal?: AbortSignal): Promise<number | null> {
    if (this.duration) return this.duration;
    const et = await this.d.calendly.getEventType(await this.accessToken(signal), this.eventType, signal);
    this.duration = et.duration > 0 ? et.duration : null;
    return this.duration;
  }

  async availability(q: { from: string; to: string; durationMinutes: number; timezone?: string }, signal?: AbortSignal): Promise<TimeSlot[]> {
    const token = await this.accessToken(signal);
    const eventType = this.eventType;
    const dur = (await this.eventDuration(signal)) ?? q.durationMinutes;
    const from = new Date(Math.max(Date.parse(q.from), Date.now() + 60_000));
    const to = new Date(Math.min(Date.parse(q.to), from.getTime() + 31 * 86_400_000 - 60_000));
    if (!(to > from)) return [];
    const starts = await this.d.calendly.availableTimes(token, eventType, from, to, signal);
    return starts.slice(0, 200).map((s) => ({ start: new Date(s).toISOString(), end: new Date(Date.parse(s) + dur * 60_000).toISOString() }));
  }

  async createEvent(e: CalendarEventInput & { attendeeName?: string }, signal?: AbortSignal): Promise<{ id: string; url?: string; offered?: boolean }> {
    const token = await this.accessToken(signal);
    const eventType = this.eventType;
    const link = async () => ({ id: "scheduling_link", url: await this.d.calendly.createSchedulingLink(token, eventType, signal), offered: true });
    if (!e.attendeeEmail) return link(); // the Scheduling API needs the invitee e-mail
    try {
      const r = await this.d.calendly.createInvitee(token, {
        eventTypeUri: eventType, start: new Date(e.start).toISOString(), name: e.attendeeName?.trim() || e.attendeeEmail.split("@")[0]!, email: e.attendeeEmail, timezone: e.timezone || "UTC",
      }, signal);
      return { id: uuidOf(r.eventUri), url: r.url };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) return link(); // Free plan: Scheduling API is paid-only
      throw err;
    }
  }

  async cancelEvent(id: string, signal?: AbortSignal, reason?: string): Promise<void> {
    try {
      await this.d.calendly.cancelEvent(await this.accessToken(signal), id, reason, signal);
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  }
}

export type TenantCalendar = TenantGoogleCalendar | TenantCalendlyCalendar;

/**
 * The tenant's calendar for the AI and the API: the default connected provider whose client is configured on this server.
 * `provider` forces one (e.g. cancelling a booking made on the other provider).
 */
export async function loadTenantCalendarAny(d: AnyCalendarDeps, tenantId: string, provider?: "google" | "calendly"): Promise<TenantCalendar | null> {
  const rows = await withTenant(d.db, tenantId, (tx) => tx<(Conn & { provider: string })[]>`
    SELECT provider, calendar_id, credentials_encrypted FROM calendar_connections
    WHERE tenant_id = ${tenantId} ${provider ? tx`AND provider = ${provider}` : tx``}
    ORDER BY (status = 'active') DESC, is_default DESC, updated_at DESC`);
  for (const r of rows) {
    if (r.provider === "google" && d.google) return new TenantGoogleCalendar({ db: d.db, encryptionKey: d.encryptionKey, google: d.google }, tenantId, r);
    if (r.provider === "calendly" && d.calendly) return new TenantCalendlyCalendar({ db: d.db, encryptionKey: d.encryptionKey, calendly: d.calendly }, tenantId, r);
  }
  return null;
}
