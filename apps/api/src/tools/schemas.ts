import { z } from "zod";

export const connectionAuthType = z.enum(["none", "bearer", "api_key", "basic", "hmac"]);
const name = z.string().trim().min(1).max(100);
const baseUrl = z.string().trim().min(8).max(2000);
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "letters, digits and - only");
const testPath = z.string().max(500).regex(/^\/(?!\/)/, "must start with a single /");
/** write-only credential: bearer token / API key / "user:password" (basic) / signing secret (hmac) */
const secret = z.string().min(1).max(2000);

export const createConnectionSchema = z.strictObject({
  name,
  kind: z.literal("http").default("http"),
  baseUrl,
  authType: connectionAuthType.default("none"),
  /** api_key only: header that carries the key (default X-API-Key) */
  authHeaderName: headerName.optional(),
  secret: secret.optional(),
  testPath: testPath.optional(),
});
export const updateConnectionSchema = z.strictObject({
  name: name.optional(),
  baseUrl: baseUrl.optional(),
  authType: connectionAuthType.optional(),
  authHeaderName: headerName.nullable().optional(),
  /** a new credential replaces the stored one; null removes it (only valid with authType none) */
  secret: secret.nullable().optional(),
  testPath: testPath.nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, "Nothing to update");
export const testConnectionSchema = z.strictObject({ path: testPath.optional() });

export const testToolSchema = z.strictObject({
  /** a manifest v2 (the one the builder is editing; it does not have to be saved on an agent) */
  manifest: z.record(z.string(), z.unknown()),
  /** sample values for the tool's input fields */
  sampleValues: z.record(z.string(), z.unknown()).default({}),
});
