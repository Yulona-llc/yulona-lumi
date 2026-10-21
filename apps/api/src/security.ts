import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sign, verify } from "hono/jwt";
import { accessClaimsSchema, type AccessClaims, type Role } from "@yulona/shared";

export async function hashPassword(pw: string): Promise<string> {
  // OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1).
  return Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}

let dummyHash: Promise<string> | undefined;
/** Verify against a throwaway hash when the user doesn't exist so timing doesn't reveal it. */
export async function verifyPassword(pw: string, hash: string | undefined): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword("yulona-timing-equalizer");
    await Bun.password.verify(pw, await dummyHash).catch(() => false);
    return false;
  }
  return Bun.password.verify(pw, hash).catch(() => false);
}

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
/** Refresh tokens are 256-bit random, so a plain SHA-256 is sufficient for at-rest hashing. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function signAccessToken(
  secret: string,
  p: { userId: string; tenantId: string; role: Role; ttlSeconds: number; impersonation?: { adminId: string; sessionId: string } },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = { sub: p.userId, tid: p.tenantId, role: p.role, iat, exp: iat + p.ttlSeconds, jti: crypto.randomUUID(),
    ...(p.impersonation ? { imp: p.impersonation.adminId, ims: p.impersonation.sessionId } : {}) };
  return sign(claims, secret, "HS256");
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims | null> {
  try {
    const payload = await verify(token, secret, "HS256");
    const parsed = accessClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
