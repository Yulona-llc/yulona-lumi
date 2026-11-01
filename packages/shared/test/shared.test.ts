import { describe, expect, test } from "bun:test";
import { canTransition, createLogger, loginSchema, registerSchema, redact, allowedNextStages, widgetConfigSchema } from "../src";

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

describe("widget appearance (additive)", () => {
  test("old configs without appearance still parse; primaryColor is kept", () => {
    const r = widgetConfigSchema.safeParse({ title: "Hi", primaryColor: "#112233", avatarUrl: "https://x.test/a.png" });
    expect(r.success).toBe(true);
    expect(r.data?.appearance).toBeUndefined();
  });
  test("solid and gradient appearance, defaults, and rejects bad colours or angles", () => {
    const solid = widgetConfigSchema.parse({ appearance: { color: "#f97316" } });
    expect(solid.appearance).toEqual({ mode: "solid", color: "#f97316", angle: 135 });
    const g = widgetConfigSchema.parse({ appearance: { mode: "gradient", color: "#f97316", color2: "#ec4899", angle: 90 } });
    expect(g.appearance?.color2).toBe("#ec4899");
    expect(widgetConfigSchema.safeParse({ appearance: { mode: "gradient", color: "orange" } }).success).toBe(false);
    expect(widgetConfigSchema.safeParse({ appearance: { color: "#f97316", angle: 400 } }).success).toBe(false);
    expect(widgetConfigSchema.safeParse({ appearance: { color: "#f97316", css: "x" } }).success).toBe(false);
  });
});
