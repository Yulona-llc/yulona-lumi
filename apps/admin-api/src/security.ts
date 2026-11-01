import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sign, verify } from "hono/jwt";

export async function hashPassword(pw: string): Promise<string> {
  return Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}
let dummyHash: Promise<string> | undefined;
/** Verify against a throwaway hash when the admin does not exist so timing does not reveal it. */
export async function verifyPassword(pw: string, hash: string | undefined): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword("yulona-admin-timing-equalizer");
    await Bun.password.verify(pw, await dummyHash).catch(() => false);
    return false;
  }
  return Bun.password.verify(pw, hash).catch(() => false);
}
export const newOpaqueToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
/** Readable temporary password (shown once to an owner). */
export function temporaryPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(20);
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
}

export type TokenType = "sa" | "sa2fa";
export async function signAdminToken(secret: string, claims: { sub: string; typ: TokenType; sid?: string }, ttlSeconds: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({ ...claims, iat, exp: iat + ttlSeconds, jti: crypto.randomUUID() }, secret, "HS256");
}
export async function verifyAdminToken(secret: string, token: string, typ: TokenType): Promise<{ sub: string; sid?: string } | null> {
  try {
    const p = await verify(token, secret, "HS256");
    if (p.typ !== typ || typeof p.sub !== "string") return null;
    if (typ === "sa" && typeof p.sid !== "string") return null;
    return { sub: p.sub, sid: typeof p.sid === "string" ? p.sid : undefined };
  } catch {
    return null;
  }
}
