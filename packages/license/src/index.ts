/**
 * Offline licensing for self-hosted Yulona. Zero network access: nothing here ever sends tenant data anywhere.
 *
 *  - License: a compact JWT signed with Ed25519 (alg "EdDSA"), claims { iss, sub (customer id), customer, seats, features[], iat, exp }.
 *  - Update manifest: JSON { payload: {...}, signature } where signature = base64url(Ed25519(sign, canonical JSON of payload)).
 *  - The PUBLIC key is supplied via env/file (LICENSE_PUBLIC_KEY / LICENSE_PUBLIC_KEY_FILE, PEM). The private key never ships.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export interface LicenseClaims {
  customer: string;
  seats: number;
  features: string[];
  iat: number;
  exp: number;
  sub?: string;
  iss?: string;
}
export type LicenseFailure = "malformed" | "bad_algorithm" | "bad_signature" | "expired" | "not_yet_valid" | "invalid_claims";
export type LicenseResult = { ok: true; claims: LicenseClaims } | { ok: false; reason: LicenseFailure };

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const keyOf = (k: string | KeyObject, kind: "public" | "private") =>
  typeof k === "string" ? (kind === "public" ? createPublicKey(k) : createPrivateKey(k)) : k;

/** Vendor-side / test helper. Never called by the running product. */
export function signLicense(claims: Omit<LicenseClaims, "iat"> & { iat?: number }, privateKeyPem: string | KeyObject): string {
  const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: "yulona", ...claims, iat: claims.iat ?? Math.floor(Date.now() / 1000) }));
  const sig = sign(null, Buffer.from(`${header}.${body}`), keyOf(privateKeyPem, "private"));
  return `${header}.${body}.${b64u(sig)}`;
}

export function verifyLicense(token: string, publicKey: string | KeyObject, opts: { now?: number; leewaySeconds?: number } = {}): LicenseResult {
  const parts = token.trim().split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, b, s] = parts as [string, string, string];
  let header: { alg?: string }; let claims: Partial<LicenseClaims>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
  } catch { return { ok: false, reason: "malformed" }; }
  if (header.alg !== "EdDSA") return { ok: false, reason: "bad_algorithm" }; // never trust alg=none / HS*
  let good = false;
  try { good = verify(null, Buffer.from(`${h}.${b}`), keyOf(publicKey, "public"), Buffer.from(s, "base64url")); } catch { /* bad key/sig */ }
  if (!good) return { ok: false, reason: "bad_signature" };
  if (typeof claims.customer !== "string" || !Number.isInteger(claims.seats) || (claims.seats as number) < 0 ||
      !Array.isArray(claims.features) || !claims.features.every((f) => typeof f === "string") ||
      !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) return { ok: false, reason: "invalid_claims" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = opts.leewaySeconds ?? 60;
  if (claims.exp! + leeway < now) return { ok: false, reason: "expired" };
  if (claims.iat! - leeway > now) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: claims as LicenseClaims };
}

/** Deterministic JSON (sorted keys) so signer and verifier agree byte-for-byte. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface UpdateManifestPayload { version: string; releasedAt: string; images: Record<string, string>; notes?: string; minVersion?: string }
export interface SignedManifest { payload: UpdateManifestPayload; signature: string }

export function signManifest(payload: UpdateManifestPayload, privateKeyPem: string | KeyObject): SignedManifest {
  return { payload, signature: b64u(sign(null, Buffer.from(canonicalJson(payload)), keyOf(privateKeyPem, "private"))) };
}

export function verifyManifest(m: unknown, publicKey: string | KeyObject): { ok: true; payload: UpdateManifestPayload } | { ok: false; reason: "malformed" | "bad_signature" } {
  const mm = m as Partial<SignedManifest> | null;
  if (!mm || typeof mm !== "object" || typeof mm.signature !== "string" || !mm.payload || typeof mm.payload !== "object") return { ok: false, reason: "malformed" };
  let good = false;
  try { good = verify(null, Buffer.from(canonicalJson(mm.payload)), keyOf(publicKey, "public"), Buffer.from(mm.signature, "base64url")); } catch { /* ignore */ }
  return good ? { ok: true, payload: mm.payload as UpdateManifestPayload } : { ok: false, reason: "bad_signature" };
}

type Env = Record<string, string | undefined>;
const readMaybe = (inline?: string, file?: string) => inline?.trim() || (file ? readFileSync(file, "utf8").trim() : undefined);

export function publicKeyFromEnv(env: Env = process.env): string | undefined {
  return readMaybe(env.LICENSE_PUBLIC_KEY?.replace(/\\n/g, "\n"), env.LICENSE_PUBLIC_KEY_FILE);
}

export type LicenseStatus =
  | { state: "none" }
  | { state: "valid"; claims: LicenseClaims; daysLeft: number }
  | { state: "invalid"; reason: LicenseFailure | "no_public_key" };

export function loadLicenseStatus(env: Env = process.env, now = Math.floor(Date.now() / 1000)): LicenseStatus {
  const token = readMaybe(env.LICENSE_KEY, env.LICENSE_KEY_FILE);
  if (!token) return { state: "none" };
  const pub = publicKeyFromEnv(env);
  if (!pub) return { state: "invalid", reason: "no_public_key" };
  const r = verifyLicense(token, pub, { now });
  return r.ok ? { state: "valid", claims: r.claims, daysLeft: Math.floor((r.claims.exp - now) / 86400) } : { state: "invalid", reason: r.reason };
}

/**
 * Gating hook for self-hosted mode. Policy: no license => community defaults (caller decides limits);
 * valid license => `seats` and `features` apply; expired/invalid => treated as no license (never bricks data access).
 */
export function createLicenseGate(getStatus: () => LicenseStatus) {
  return {
    status: getStatus,
    hasFeature(feature: string): boolean {
      const s = getStatus();
      return s.state === "valid" && (s.claims.features.includes(feature) || s.claims.features.includes("*"));
    },
    /** Max seats allowed, or `communitySeats` when unlicensed. */
    seatLimit(communitySeats: number): number {
      const s = getStatus();
      return s.state === "valid" ? s.claims.seats : communitySeats;
    },
  };
}
