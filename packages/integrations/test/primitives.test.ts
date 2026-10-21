import { describe, expect, test } from "bun:test";
import { generateWebhookSecret, openSecret, sealSecret, signWebhook, verifyWebhookSignature, webhookUrlProblem } from "../src";

const ENC_KEY = Buffer.alloc(32, 9).toString("base64");

describe("webhook primitives (unit)", () => {
  test("signature verifies, rejects tampering, stale timestamps and wrong secrets", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ hello: "world" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook(secret, ts, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, body, { timestamp: ts, signature: sig })).toBe(true);
    expect(verifyWebhookSignature(secret, body + " ", { timestamp: ts, signature: sig })).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, { timestamp: ts, signature: sig })).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyWebhookSignature(secret, body, { timestamp: old, signature: signWebhook(secret, old, body) })).toBe(false);
  });
  test("secret envelope is bound to the webhook id and key", () => {
    const s = sealSecret(ENC_KEY, "whsec_abc", "id-1");
    expect(s).not.toContain("whsec_abc");
    expect(openSecret(ENC_KEY, s, "id-1")).toBe("whsec_abc");
    expect(() => openSecret(ENC_KEY, s, "id-2")).toThrow();
    expect(() => openSecret(Buffer.alloc(32, 1).toString("base64"), s, "id-1")).toThrow();
    expect(() => sealSecret(undefined, "x", "id")).toThrow();
  });
  test("url validation", () => {
    const prod = { allowHttp: false };
    expect(webhookUrlProblem("https://example.com/hook", prod)).toBeNull();
    expect(webhookUrlProblem("http://example.com/hook", prod)).toBe("URL must use https");
    expect(webhookUrlProblem("http://example.com/hook", { allowHttp: true })).toBeNull();
    for (const bad of ["https://localhost/x", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://169.254.169.254/latest", "https://[::1]/x",
      "https://2130706433/x", "https://user:pw@example.com/x", "ftp://example.com/x", "not a url", "https://printer.local/x", "https://svc.internal/x"]) {
      expect([bad, webhookUrlProblem(bad, prod) !== null]).toEqual([bad, true]);
    }
  });
});

