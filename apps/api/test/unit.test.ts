import { describe, expect, test } from "bun:test";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { MemoryRateLimiter } from "../src/ratelimit";
import { DOCS_PASS, DOCS_USER, docsAuth } from "./helpers";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const base = { DATABASE_URL: "postgres://yulona_app:Zx9!pQ7rT2vLm4@db:5432/yulona" };

describe("production config safety", () => {
  const good = { ...base, NODE_ENV: "production", JWT_SECRET: "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W" };
  test("accepts a strong config", () => expect(loadConfig(good).isProd).toBe(true));
  test("refuses weak JWT secrets", () => {
    for (const s of ["a".repeat(40), "change-me-change-me-change-me-change-me", "secretsecretsecretsecretsecretsecret"]) {
      expect(() => loadConfig({ ...good, JWT_SECRET: s })).toThrow(/weak/);
    }
    expect(() => loadConfig({ ...good, JWT_SECRET: "short" })).toThrow(/32/);
  });
  test("refuses dev DB password and wildcard CORS", () => {
    expect(() => loadConfig({ ...good, DATABASE_URL: "postgres://yulona_app:yulona_app@db/yulona" })).toThrow(/development default/);
    expect(() => loadConfig({ ...good, CORS_ORIGINS: "*" })).toThrow(/CORS/);
  });
  test("dev allows relaxed config, signup off by default", () => {
    const c = loadConfig({ ...base, JWT_SECRET: "x".repeat(32) });
    expect(c.allowPublicSignup).toBe(false);
    expect(c.openapiEnabled).toBe(true);
    expect(loadConfig(good).openapiEnabled).toBe(false);
  });
  test("refuses public docs in production and weak docs passwords", () => {
    expect(() => loadConfig({ ...good, OPENAPI_ENABLED: "true" })).toThrow(/DOCS_PASSWORD/);
    expect(() => loadConfig({ ...good, OPENAPI_ENABLED: "true", DOCS_PASSWORD: "passwordpassword" })).toThrow(/weak/);
    expect(loadConfig({ ...good, OPENAPI_ENABLED: "true", DOCS_PASSWORD: DOCS_PASS }).docsUsername).toBe("docs");
  });
});

describe("scalar docs", () => {
  function appWith(env: Record<string, string>) {
    const cfg = loadConfig({ ...base, JWT_SECRET: "x".repeat(32), LOG_LEVEL: "silent", ...env });
    const limiter = new MemoryRateLimiter();
    const app = createApp({ cfg, db: {} as never, limiter, log: createLogger({ level: "silent" }) });
    return { app, close: () => limiter.close() };
  }

  test("requires basic auth for the reference and the spec", async () => {
    const { app, close } = appWith({ OPENAPI_ENABLED: "true", DOCS_USERNAME: DOCS_USER, DOCS_PASSWORD: DOCS_PASS });
    try {
      const anon = await app.request("/docs");
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toContain("Basic");
      expect(await anon.text()).not.toContain("openapi");
      expect((await app.request("/api/v1/openapi.json")).status).toBe(401);
      const bad = await app.request("/docs", { headers: { authorization: `Basic ${Buffer.from("docs:wrong-password-value").toString("base64")}` } });
      expect(bad.status).toBe(401);
      const slash = await app.request("/docs/", { headers: docsAuth() });
      expect(slash.status).toBe(301);
      expect(slash.headers.get("location")).toBe("/docs");
      const docs = await app.request("/docs", { headers: docsAuth() });
      expect(docs.status).toBe(200);
      expect(docs.headers.get("content-type")).toContain("text/html");
      expect(docs.headers.get("cache-control")).toBe("no-store");
      expect(await docs.text()).toContain("/api/v1/openapi.json");
      expect((await app.request("/api/v1/openapi.json", { headers: docsAuth() })).status).toBe(200);
    } finally {
      close();
    }
  });

  test("hides the reference when OpenAPI is disabled or no docs password is set", async () => {
    const disabled = appWith({ OPENAPI_ENABLED: "false", DOCS_PASSWORD: DOCS_PASS });
    const unconfigured = appWith({ OPENAPI_ENABLED: "true" });
    try {
      expect((await disabled.app.request("/docs", { headers: docsAuth() })).status).toBe(404);
      expect((await disabled.app.request("/api/v1/openapi.json", { headers: docsAuth() })).status).toBe(404);
      expect((await unconfigured.app.request("/docs")).status).toBe(404);
      expect((await unconfigured.app.request("/api/v1/openapi.json")).status).toBe(404);
    } finally {
      disabled.close();
      unconfigured.close();
    }
  });
});

describe("memory rate limiter", () => {
  test("sliding window blocks then allows", async () => {
    const l = new MemoryRateLimiter();
    expect((await l.hit("k", 2, 100)).allowed).toBe(true);
    expect((await l.hit("k", 2, 100)).allowed).toBe(true);
    const blocked = await l.hit("k", 2, 100);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    await Bun.sleep(120);
    expect((await l.hit("k", 2, 100)).allowed).toBe(true);
    l.close();
  });
});

describe("tenant-safety guard (static)", () => {
  const files = readdirSync(join(import.meta.dir, "../src"), { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  test("api never uses raw postgres / unsafe SQL directly", () => {
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, "../src", String(f)), "utf8");
      expect(src).not.toMatch(/from ["']postgres["']/);
      expect(src).not.toMatch(/\.unsafe\(/);
    }
  });
  test("tenantId is never read from request input", () => {
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, "../src", String(f)), "utf8");
      expect(src).not.toMatch(/(c\.req\.(param|query|json)|body|raw)\W*[.(\[]\W*["']?tenant_?[Ii]d/);
    }
  });
});
