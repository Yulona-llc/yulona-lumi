import { createDb, type Db } from "@yulona/db";
import { setupTestDb, testUrls } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { MemoryRateLimiter } from "../src/ratelimit";

export const hasDb = !!testUrls();
export const SECRET = "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W";
export const DOCS_USER = "docs";
export const DOCS_PASS = "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ";
export function docsAuth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${DOCS_USER}:${DOCS_PASS}`).toString("base64")}` };
}

export function testConfig(over: Partial<Record<string, string>> = {}, patch: (c: Config) => void = () => {}): Config {
  const urls = testUrls();
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: urls?.app ?? "postgres://x:y@localhost:1/x",
    JWT_SECRET: SECRET,
    ALLOW_PUBLIC_SIGNUP: "true",
    LOG_LEVEL: "silent",
    CORS_ORIGINS: "http://localhost:5173",
    DOCS_USERNAME: DOCS_USER,
    DOCS_PASSWORD: DOCS_PASS,
    ...over,
  });
  patch(cfg);
  return cfg;
}

export async function makeApp(over: Partial<Record<string, string>> = {}, patch?: (c: Config) => void) {
  const { owner, app: db } = await setupTestDb();
  const cfg = testConfig(over, patch);
  const limiter = new MemoryRateLimiter();
  const log = createLogger({ level: "silent" });
  const app = createApp({ cfg, db, limiter, log });
  return { app, db: db as Db, owner, cfg, limiter, close: async () => { limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); } };
}

export function uniqueEmail(p = "u") {
  return `${p}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}
export const PASSWORD = "correct horse battery staple";

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** Parse Set-Cookie headers into name -> value. */
export function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}
export function cookieHeader(c: Record<string, string>): string {
  return Object.entries(c).map(([k, v]) => `${k}=${v}`).join("; ");
}
