import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Yulona-Signature";
export const TIMESTAMP_HEADER = "X-Yulona-Timestamp";
export const EVENT_HEADER = "X-Yulona-Event";
export const DELIVERY_HEADER = "X-Yulona-Delivery";

/** `whsec_<43 chars>`; shown to the user exactly once. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex, prefixed `v1=`. */
export function signWebhook(secret: string, timestamp: number | string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** Receiver-side helper (also used by tests/docs). Rejects stale timestamps (replay protection). */
export function verifyWebhookSignature(
  secret: string, rawBody: string, headers: { timestamp: string; signature: string }, toleranceSec = 300, nowMs = Date.now(),
): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, headers.timestamp, rawBody));
  const got = Buffer.from(headers.signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ---- secret-at-rest: AES-256-GCM with ENCRYPTION_KEY (base64, 32 bytes), bound to the webhook id ----
function masterKey(b64: string | undefined): Buffer {
  const v = b64?.trim() ?? "";
  const k = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes: base64 (openssl rand -base64 32) or 64 hex chars (openssl rand -hex 32)");
  return k;
}
export function sealSecret(keyB64: string | undefined, secret: string, webhookId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(keyB64), iv);
  c.setAAD(Buffer.from(webhookId));
  const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return `ws1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}
export function openSecret(keyB64: string | undefined, sealed: string, webhookId: string): string {
  const [v, b] = sealed.split(".");
  if (v !== "ws1" || !b) throw new Error("unsupported secret envelope");
  const blob = Buffer.from(b, "base64url");
  const d = createDecipheriv("aes-256-gcm", masterKey(keyB64), blob.subarray(0, 12));
  d.setAAD(Buffer.from(webhookId));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
}
