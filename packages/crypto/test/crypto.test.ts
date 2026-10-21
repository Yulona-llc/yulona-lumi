import { describe, expect, test } from "bun:test";
import { decryptCredentials, decryptJson, encryptCredentials, encryptJson } from "../src";

const key = Buffer.alloc(32, 3).toString("base64");
describe("@yulona/crypto", () => {
  test("round trip, fresh nonce per call, AAD binding, wrong key, tamper, bad key length", () => {
    const a = encryptJson(key, { s: "secret" }, "c1");
    expect(a).not.toContain("secret");
    expect(encryptJson(key, { s: "secret" }, "c1")).not.toBe(a);
    expect(decryptJson(key, a, "c1")).toEqual({ s: "secret" });
    expect(() => decryptJson(key, a, "c2")).toThrow();
    expect(() => decryptJson(Buffer.alloc(32, 4).toString("base64"), a, "c1")).toThrow();
    const [v, w, d] = a.split(".");
    expect(() => decryptJson(key, `${v}.${w}.${d!.slice(0, -2)}AA`, "c1")).toThrow();
    expect(() => encryptJson("short", {})).toThrow();
    expect(() => decryptJson(key, "v2.a.b")).toThrow();
    expect(decryptCredentials(key, encryptCredentials(key, { token: "t" }))).toEqual({ token: "t" });
  });
});

import { parseMasterKey } from "../src";
test("master key accepts base64 and 64-char hex, rejects others", () => {
  expect(parseMasterKey(Buffer.alloc(32, 1).toString("base64")).length).toBe(32);
  expect(parseMasterKey(Buffer.alloc(32, 1).toString("hex")).length).toBe(32);
  expect(() => parseMasterKey(Buffer.alloc(48, 1).toString("base64"))).toThrow();
});
