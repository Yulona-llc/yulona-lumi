import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createLicenseGate, loadLicenseStatus, signLicense, signManifest, verifyLicense, verifyManifest } from "../src";

const newPair = () => {
  const k = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { pub: k.publicKey, priv: k.privateKey };
};
const a = newPair();
const b = newPair();
const now = 1_800_000_000;
const claims = { customer: "Acme", seats: 25, features: ["sso"], iat: now - 10, exp: now + 86400 * 30 };

describe("license", () => {
  test("valid license verifies", () => {
    const r = verifyLicense(signLicense(claims, a.priv), a.pub, { now });
    expect(r.ok && r.claims.customer).toBe("Acme");
  });
  test("wrong key, tamper, expiry, alg downgrade are rejected", () => {
    const t = signLicense(claims, a.priv);
    expect(verifyLicense(t, b.pub, { now })).toEqual({ ok: false, reason: "bad_signature" });
    const [h, body, s] = t.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, seats: 9999 })).toString("base64url");
    expect(verifyLicense(`${h}.${forged}.${s}`, a.pub, { now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyLicense(t, a.pub, { now: claims.exp + 3600 })).toEqual({ ok: false, reason: "expired" });
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    expect(verifyLicense(`${none}.${body}.`, a.pub, { now })).toEqual({ ok: false, reason: "bad_algorithm" });
    expect(verifyLicense("garbage", a.pub)).toEqual({ ok: false, reason: "malformed" });
  });
  test("manifest sign/verify is key-order independent and tamper-evident", () => {
    const m = signManifest({ version: "1.2.0", releasedAt: "2026-01-01", images: { api: "sha256:aa" } }, a.priv);
    expect(verifyManifest(m, a.pub).ok).toBe(true);
    const reordered = { signature: m.signature, payload: { images: { api: "sha256:aa" }, releasedAt: "2026-01-01", version: "1.2.0" } };
    expect(verifyManifest(reordered, a.pub).ok).toBe(true);
    expect(verifyManifest({ ...m, payload: { ...m.payload, version: "9.9.9" } }, a.pub).ok).toBe(false);
    expect(verifyManifest({ nope: 1 }, a.pub)).toEqual({ ok: false, reason: "malformed" });
  });
  test("env loading and gate", () => {
    const env = { LICENSE_KEY: signLicense(claims, a.priv), LICENSE_PUBLIC_KEY: a.pub };
    const s = loadLicenseStatus(env, now);
    expect(s.state).toBe("valid");
    const g = createLicenseGate(() => s);
    expect(g.hasFeature("sso")).toBe(true);
    expect(g.hasFeature("audit-export")).toBe(false);
    expect(g.seatLimit(3)).toBe(25);
    expect(loadLicenseStatus({}, now).state).toBe("none");
    expect(loadLicenseStatus({ LICENSE_KEY: env.LICENSE_KEY }, now)).toEqual({ state: "invalid", reason: "no_public_key" });
    expect(createLicenseGate(() => ({ state: "none" })).seatLimit(3)).toBe(3);
  });
});
