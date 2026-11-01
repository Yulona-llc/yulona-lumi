import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** RFC 4226 HOTP (SHA-1, 6 digits). */
export function hotp(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}
export const totpStep = (nowMs = Date.now()): number => Math.floor(nowMs / 1000 / 30);

/** Returns the matching time step (within +-1) or null. */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const base = totpStep(nowMs);
  for (const w of [0, -1, 1]) {
    const step = base + w;
    const expect = Buffer.from(hotp(secretB32, step));
    if (timingSafeEqual(expect, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, email: string, issuer = "Lumi Admin"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
export function newRecoveryCode(): string {
  const b = randomBytes(10);
  const s = Array.from(b, (x) => RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeRecoveryCode = (c: string): string => c.toLowerCase().replace(/[\s-]/g, "");
