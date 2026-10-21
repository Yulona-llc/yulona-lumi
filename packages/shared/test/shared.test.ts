import { describe, expect, test } from "bun:test";
import { canTransition, createLogger, loginSchema, registerSchema, redact, allowedNextStages } from "../src";

describe("stage machine", () => {
  test("allows only declared transitions", () => {
    expect(canTransition("visitor", "engaged")).toBe(true);
    expect(canTransition("visitor", "booked")).toBe(false);
    expect(allowedNextStages("booked")).toEqual(["handoff_requested"]);
  });
});

describe("auth schemas", () => {
  test("strict: rejects unknown / tenant fields", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x", tenantId: "t" }).success).toBe(false);
    expect(
      registerSchema.safeParse({ email: "A@B.co ", password: "a-long-password!", name: "n", workspaceName: "w" }).data?.email,
    ).toBe("a@b.co");
    expect(registerSchema.safeParse({ email: "a@b.co", password: "short", name: "n", workspaceName: "w" }).success).toBe(false);
  });
});

describe("logger", () => {
  test("redacts sensitive keys", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.info("x", { password: "p", nested: { refreshToken: "t", authorization: "Bearer a", ok: 1 } });
    expect(lines[0]).not.toContain("Bearer");
    expect(lines[0]).toContain("[REDACTED]");
    expect((redact({ cookie: "a" }) as any).cookie).toBe("[REDACTED]");
  });
});
