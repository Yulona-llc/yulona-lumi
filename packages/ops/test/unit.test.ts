import { describe, expect, test } from "bun:test";
import { CALENDAR_TOOL_MANIFESTS, computeSlots, csvCell, signState, signWebhook, verifyState, verifyWebhook, withRetry } from "../src";

// ---------------------------------------------------------------- pure unit tests
describe("ops unit", () => {
  test("webhook signature: valid, tampered, stale, missing", () => {
    const body = JSON.stringify({ a: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook("whsec_x", ts, body);
    expect(verifyWebhook("whsec_x", body, { timestamp: ts, signature: sig })).toBe("ok");
    expect(verifyWebhook("whsec_x", body + " ", { timestamp: ts, signature: sig })).toBe("bad_signature");
    expect(verifyWebhook("other", body, { timestamp: ts, signature: sig })).toBe("bad_signature");
    expect(verifyWebhook("whsec_x", body, { timestamp: String(Number(ts) - 3600), signature: signWebhook("whsec_x", Number(ts) - 3600, body) })).toBe("stale");
    expect(verifyWebhook("whsec_x", body, { timestamp: null, signature: sig })).toBe("missing");
  });
  test("csv cells neutralise formulas and quote", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
  test("withRetry: exponential backoff then success; timeout; gives up", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const ok = await withRetry(async () => { if (++n < 3) throw new Error("boom"); return "ok"; }, { baseMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    expect(ok).toBe("ok");
    expect(sleeps).toEqual([100, 200]);
    await expect(withRetry(() => new Promise(() => {}), { attempts: 2, timeoutMs: 20, baseMs: 1 })).rejects.toThrow(/timed out/);
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("x"); }, { attempts: 3, baseMs: 1 })).rejects.toThrow("x");
    expect(calls).toBe(3);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("fatal"); }, { attempts: 3, baseMs: 1, retryable: () => false })).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });
  test("computeSlots skips busy windows and the past", () => {
    const from = new Date("2030-01-07T09:00:00Z");
    const to = new Date("2030-01-07T11:00:00Z");
    const slots = computeSlots(from, to, 30, [{ start: "2030-01-07T09:30:00Z", end: "2030-01-07T10:00:00Z" }], { notBefore: new Date(0) });
    expect(slots.map((s) => s.start)).toEqual(["2030-01-07T09:00:00.000Z", "2030-01-07T10:00:00.000Z", "2030-01-07T10:30:00.000Z"]);
  });
  test("oauth state: signed, expiring, tamper-proof", () => {
    const s = signState("sec", { tenantId: "t", userId: "u" });
    expect(verifyState("sec", s)).toEqual({ tenantId: "t", userId: "u" });
    expect(verifyState("other", s)).toBeNull();
    expect(verifyState("sec", s.replace(/^./, "x"))).toBeNull();
    expect(verifyState("sec", signState("sec", { tenantId: "t", userId: "u" }, 600, Date.now() - 3_600_000))).toBeNull();
  });
  test("calendar tool manifests", () => {
    expect(Object.keys(CALENDAR_TOOL_MANIFESTS)).toEqual(["check_availability", "book_appointment"]);
  });
});

