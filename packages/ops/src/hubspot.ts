import { ProviderError } from "@yulona/providers";
import type { HubSpotMapping } from "@yulona/shared";
import { withRetry, type RetryOptions } from "./retry";

/**
 * HubSpot CRM v3 contacts client (verified against developers.hubspot.com: POST /crm/v3/objects/contacts/search,
 * POST /crm/v3/objects/contacts, PATCH /crm/v3/objects/contacts/{id}; private-app token as Bearer; scopes crm.objects.contacts.read and
 * crm.objects.contacts.write; search is limited to 5 requests/second/account, 429 on overload).
 * Only https://api.hubapi.com is ever contacted (tests may inject another base). Redirects are never followed. The token is
 * only placed in the Authorization header: it never appears in errors or logs.
 */
export const HUBSPOT_API = "https://api.hubapi.com";
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HubSpotError extends ProviderError {
  constructor(message: string, status: number, retryable: boolean, readonly category?: string) {
    super(message, "hubspot", retryable, status);
  }
  /** The token is wrong/revoked or lacks a scope: retrying cannot help until the admin reconnects. */
  get authFailure() { return this.status === 401 || this.status === 403; }
}
const retryable = (e: unknown) => {
  if (e instanceof HubSpotError) return e.retryable;
  return !(e instanceof Error) || e.name === "TimeoutError" || e.name === "AbortError" || /timed out|fetch|network|socket/i.test(e.message);
};

export interface HubSpotContactInput { email: string; properties: Record<string, string> }
export interface HubSpotUpsertResult { id: string; action: "created" | "updated" }

export class HubSpotClient {
  private readonly base: string;
  constructor(private readonly token: string, private readonly o: { fetchImpl?: FetchLike; apiBase?: string; retry?: RetryOptions } = {}) {
    this.base = (o.apiBase ?? HUBSPOT_API).replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.o.fetchImpl ?? fetch;
    return withRetry(async (signal) => {
      const res = await doFetch(`${this.base}${path}`, {
        method, redirect: "manual", signal,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json: { message?: string; category?: string } | null = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      if (res.status >= 300) {
        // Only the HTTP status and HubSpot's own message are kept (never the request, never the token).
        const msg = typeof json?.message === "string" ? json.message.replace(/\s+/g, " ").slice(0, 200) : "";
        throw new HubSpotError(`HubSpot HTTP ${res.status}${msg ? `: ${msg}` : ""}`, res.status, res.status >= 500 || res.status === 429 || res.status === 408, json?.category);
      }
      return (json ?? {}) as T;
    }, { retryable, ...this.o.retry });
  }

  /** Cheap authenticated call used when connecting: proves the token is valid and has the contacts read scope. */
  async testConnection(): Promise<void> {
    await this.call("GET", "/crm/v3/objects/contacts?limit=1");
  }

  async findByEmail(email: string): Promise<string | null> {
    const r = await this.call<{ results?: { id: string }[] }>("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: ["email"], limit: 1,
    });
    return r.results?.[0]?.id ?? null;
  }

  /** Search by email, then PATCH the match or POST a new contact. A 409 race ("already exists. Existing ID: n") falls back to PATCH. */
  async upsertContact(c: HubSpotContactInput): Promise<HubSpotUpsertResult> {
    const existing = await this.findByEmail(c.email);
    if (existing) return this.update(existing, c);
    try {
      const r = await this.call<{ id: string }>("POST", "/crm/v3/objects/contacts", { properties: { ...c.properties, email: c.email } });
      return { id: r.id, action: "created" };
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 409) {
        const id = /Existing ID:\s*(\d+)/i.exec(e.message)?.[1] ?? (await this.findByEmail(c.email));
        if (id) return this.update(id, c);
      }
      throw e;
    }
  }
  private async update(id: string, c: HubSpotContactInput): Promise<HubSpotUpsertResult> {
    const { lifecyclestage: _omit, ...props } = c.properties; // lifecycle only on create (HubSpot moves it forward only)
    await this.call("PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties: { ...props, email: c.email } });
    return { id, action: "updated" };
  }
}

export interface LeadForCrm { name?: string; email?: string; phone?: string; need?: string; budget?: string; timeline?: string; score?: number }

/** Map a lead to HubSpot contact properties. Only mapped custom properties are sent (HubSpot rejects unknown ones). */
export function buildHubSpotProperties(lead: LeadForCrm, mapping: HubSpotMapping, conversationUrl: string | null): Record<string, string> {
  const p: Record<string, string> = {};
  const name = lead.name?.trim();
  if (name) {
    const i = name.indexOf(" ");
    p.firstname = (i < 0 ? name : name.slice(0, i)).slice(0, 200);
    if (i > 0) p.lastname = name.slice(i + 1).trim().slice(0, 200);
  }
  if (lead.phone) p.phone = lead.phone;
  const m = mapping.properties;
  if (m.need && lead.need) p[m.need] = lead.need.slice(0, 2000);
  if (m.budget && lead.budget) p[m.budget] = lead.budget.slice(0, 500);
  if (m.timeline && lead.timeline) p[m.timeline] = lead.timeline.slice(0, 500);
  if (m.score && lead.score !== undefined) p[m.score] = String(lead.score);
  if (m.conversationLink && conversationUrl) p[m.conversationLink] = conversationUrl;
  if (m.source) p[m.source] = mapping.sourceValue;
  if (mapping.lifecycleStage) p.lifecyclestage = mapping.lifecycleStage;
  return p;
}
