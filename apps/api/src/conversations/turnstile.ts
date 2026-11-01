import { decryptJson, encryptJson } from "@yulona/crypto";

export const turnstileAad = (tenantId: string, widgetId: string) => `widget-turnstile:${tenantId}:${widgetId}`;
export const sealTurnstileSecret = (key: string, tenantId: string, widgetId: string, secret: string) =>
  encryptJson(key, { secret }, turnstileAad(tenantId, widgetId));
export const openTurnstileSecret = (key: string, envelope: string, tenantId: string, widgetId: string) =>
  decryptJson<{ secret: string }>(key, envelope, turnstileAad(tenantId, widgetId)).secret;

export interface TurnstileResult {
  ok: boolean;
  /** why it failed: no_token | siteverify_rejected | siteverify_unreachable | siteverify_bad_response | misconfigured */
  reason?: string;
  errorCodes?: string[];
}

/**
 * Server-side Turnstile verification. Fails closed: a missing token, a rejected token, a timeout, a network error or an
 * unreadable response all return `ok: false`. The secret is only ever sent to Cloudflare (or the configured verify URL).
 */
export async function verifyTurnstile(o: {
  url: string; secret: string; token: string | undefined; ip?: string; timeoutMs?: number; fetchImpl?: typeof fetch;
}): Promise<TurnstileResult> {
  if (!o.token) return { ok: false, reason: "no_token" };
  const body = new URLSearchParams({ secret: o.secret, response: o.token });
  if (o.ip && o.ip !== "unknown") body.set("remoteip", o.ip);
  try {
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      method: "POST", body, signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) return { ok: false, reason: "siteverify_bad_response" };
    const j = (await res.json()) as { success?: unknown; "error-codes"?: unknown };
    if (j.success === true) return { ok: true };
    return { ok: false, reason: "siteverify_rejected", errorCodes: Array.isArray(j["error-codes"]) ? (j["error-codes"] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 5) : [] };
  } catch {
    return { ok: false, reason: "siteverify_unreachable" };
  }
}
