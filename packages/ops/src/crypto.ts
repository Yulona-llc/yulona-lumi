import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// AES-256-GCM envelope encryption now lives in @yulona/crypto (re-exported for existing importers).
export { encryptJson, decryptJson } from "@yulona/crypto";

// ---- HMAC helpers ---------------------------------------------------------------------------
export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signature header value for inbound transaction webhooks: `sha256=<hex(HMAC(secret, "<ts>.<body>"))>`. */
export function signWebhook(secret: string, timestamp: string | number, rawBody: string): string {
  return `sha256=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}
export type WebhookVerdict = "ok" | "missing" | "stale" | "bad_signature";
export function verifyWebhook(
  secret: string, rawBody: string, headers: { timestamp?: string | null; signature?: string | null },
  opts: { toleranceSec?: number; nowMs?: number } = {},
): WebhookVerdict {
  const ts = headers.timestamp?.trim();
  const sig = headers.signature?.trim();
  if (!ts || !sig || !/^\d{9,13}$/.test(ts)) return "missing";
  const now = (opts.nowMs ?? Date.now()) / 1000;
  if (Math.abs(now - Number(ts)) > (opts.toleranceSec ?? 300)) return "stale";
  return safeEqualHex(sig, signWebhook(secret, ts, rawBody)) ? "ok" : "bad_signature";
}

/** HMAC-signed, expiring OAuth state bound to tenant + user (no server-side storage needed). */
export function signState(secret: string, payload: { tenantId: string; userId: string }, ttlSec = 600, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + ttlSec, n: randomBytes(8).toString("hex") })).toString("base64url");
  return `${body}.${hmacHex(`oauth-state:${secret}`, body)}`;
}
export function verifyState(secret: string, state: string, nowMs = Date.now()): { tenantId: string; userId: string } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqualHex(sig, hmacHex(`oauth-state:${secret}`, body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { tenantId: string; userId: string; exp: number };
    if (typeof p.exp !== "number" || p.exp < nowMs / 1000) return null;
    return { tenantId: p.tenantId, userId: p.userId };
  } catch {
    return null;
  }
}

/** CSV cell: quote when needed and neutralise spreadsheet formula injection (= + - @ tab CR). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !(typeof v === "number")) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";
