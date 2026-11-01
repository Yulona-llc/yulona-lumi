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
