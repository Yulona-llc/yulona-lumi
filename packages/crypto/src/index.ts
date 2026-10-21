import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope encryption shared by api, worker and ops (single implementation).
 * Each record gets a random data key (DEK); the DEK is wrapped with the master key (ENCRYPTION_KEY).
 * Format: `v1.<b64url(wrap iv|tag|ct)>.<b64url(data iv|tag|ct)>`.
 */
/** Accepts a 32-byte key as base64 (`openssl rand -base64 32`) or 64 hex chars (`openssl rand -hex 32`). */
export function parseMasterKey(raw: string): Buffer {
  const v = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes: base64 (openssl rand -base64 32) or 64 hex chars (openssl rand -hex 32)");
  return key;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export function encryptJson(masterKeyB64: string, value: Record<string, unknown>, aad = ""): string {
  const master = parseMasterKey(masterKeyB64);
  const dek = randomBytes(32);
  const wrapped = seal(master, dek, "dek");
  const data = seal(dek, Buffer.from(JSON.stringify(value)), aad);
  return `v1.${wrapped.toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptJson<T = Record<string, unknown>>(masterKeyB64: string, envelope: string, aad = ""): T {
  const [v, w, d] = envelope.split(".");
  if (v !== "v1" || !w || !d) throw new Error("Unsupported envelope");
  const dek = open(parseMasterKey(masterKeyB64), Buffer.from(w, "base64url"), "dek");
  return JSON.parse(open(dek, Buffer.from(d, "base64url"), aad).toString("utf8")) as T;
}

/** Channel-credential flavour (string maps) kept for existing importers. */
export const encryptCredentials = (masterKeyB64: string, credentials: Record<string, string>, aad = ""): string =>
  encryptJson(masterKeyB64, credentials, aad);
export const decryptCredentials = (masterKeyB64: string, envelope: string, aad = ""): Record<string, string> =>
  decryptJson<Record<string, string>>(masterKeyB64, envelope, aad);
