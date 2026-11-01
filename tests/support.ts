import { createDb, type Db } from "@yulona/db";
import { setupTestDb, testUrls } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp, type AppDeps } from "../apps/api/src/app";
import { loadConfig, type Config } from "../apps/api/src/config";
import { MemoryRateLimiter } from "../apps/api/src/ratelimit";
import { createAdminApp } from "../apps/admin-api/src/app";
import { loadConfig as loadAdminConfig } from "../apps/admin-api/src/config";
import { MemoryRateLimiter as AdminLimiter } from "../apps/admin-api/src/ratelimit";
import { signAdminToken } from "../apps/admin-api/src/security";
import { signAccessToken } from "../apps/api/src/security";

export const hasDb = !!testUrls();
export const SECRET = "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W";
export const DOCS_PASS = "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ";
export const ORIGIN = "https://shop.example.test";
export const PASSWORD = "correct horse battery staple";
export const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

export const docsAuth = () => ({ authorization: `Basic ${Buffer.from(`docs:${DOCS_PASS}`).toString("base64")}` });

export function cfgFor(over: Record<string, string> = {}, patch: (c: Config) => void = () => {}): Config {
  const urls = testUrls();
  const cfg = loadConfig({
    NODE_ENV: "test", DATABASE_URL: urls?.app ?? "postgres://x:y@localhost:1/x", JWT_SECRET: SECRET, ALLOW_PUBLIC_SIGNUP: "true",
    LOG_LEVEL: "silent", CORS_ORIGINS: "http://localhost:5173", DOCS_USERNAME: "docs", DOCS_PASSWORD: DOCS_PASS, ENCRYPTION_KEY: ENC_KEY, ...over,
  });
  patch(cfg);
  return cfg;
}

/** App on a private DB with generous global limits (the sweep makes hundreds of requests). */
export async function boot(opts: Partial<AppDeps> & { env?: Record<string, string>; patch?: (c: Config) => void } = {}) {
  const t = await setupTestDb();
  const limiter = new MemoryRateLimiter();
  const log = createLogger({ level: "silent" });
  const cfg = cfgFor(opts.env, (c) => {
    for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) if (k === "global") c.rateLimits[k] = { limit: 1e7, windowMs: 60_000 };
    opts.patch?.(c);
  });
  const app = createApp({ cfg, db: t.app, limiter, log, ...opts });
  return { app, cfg, owner: t.owner, db: t.app, limiter, log, close: async () => { limiter.close(); await t.app.end({ timeout: 2 }); await t.owner.end({ timeout: 2 }); } };
}
export type Booted = Awaited<ReturnType<typeof boot>>;

export interface Tenant { tenantId: string; userId: string; token: string; h: Record<string, string>; email: string }
export async function mkTenant(b: Booted, label: string, role: "owner" | "admin" | "agent" | "viewer" = "owner", tenantId?: string): Promise<Tenant> {
  const id = crypto.randomUUID().slice(0, 8);
  let tid = tenantId;
  if (!tid) {
    const [t] = await b.owner<{ id: string }[]>`INSERT INTO tenants (name, plan_key) VALUES (${`${label}-${id}`}, 'enterprise') RETURNING id`;
    tid = t!.id;
  }
  const email = `${label}-${id}@example.test`;
  const [u] = await b.owner<{ id: string }[]>`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tid}, ${email}, ${label}, ${role}, 'x') RETURNING id`;
  const token = await signAccessToken(SECRET, { userId: u!.id, tenantId: tid, role: role === "owner" ? "owner" : role, ttlSeconds: 900 });
  return { tenantId: tid, userId: u!.id, token, h: { authorization: `Bearer ${token}` }, email };
}

const RAW = /^\/(api\/|public\/|healthz|readyz|docs)/;
export const api = (b: Booted, method: string, path: string, h: Record<string, string> = {}, body?: unknown) =>
  b.app.request(RAW.test(path) ? path : `/api/v1${path}`, {
    method, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
export const jsonOf = async <T = any>(r: Response): Promise<T> => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

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

// ---------------------------------------------------------------- the separate platform-admin service (apps/admin-api)
export const ADMIN_SECRET = "Zq8Lw3RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0Wk3Jv9sXp";
export const ADMIN_ORIGIN = "http://localhost:5180";

/** Admin API on the same database as `b`, connected as the real `yulona_admin` role (no table grants). */
export async function bootAdminOn(b: Booted, env: Record<string, string> = {}) {
  await b.owner.unsafe(`ALTER ROLE yulona_admin LOGIN PASSWORD 'yulona_admin'`);
  const u = new URL(testUrls()!.owner);
  u.username = "yulona_admin"; u.password = "yulona_admin";
  const db: Db = createDb(u.toString(), { max: 4 });
  const limiter = new AdminLimiter();
  const cfg = loadAdminConfig({ NODE_ENV: "test", ADMIN_JWT_SECRET: ADMIN_SECRET, ADMIN_DB_URL: u.toString(), ADMIN_WEB_ORIGIN: ADMIN_ORIGIN, ENCRYPTION_KEY: ENC_KEY, LOG_LEVEL: "silent",
    ADMIN_CUSTOMER_APP_URL: "https://app.example.test", ADMIN_RATE_READ: "100000", ADMIN_RATE_WRITE: "100000", ...env });
  const app = createAdminApp({ cfg, db, limiter, log: createLogger({ level: "silent" }) });
  const admin = async (role: "owner" | "support" | "billing" = "owner") => {
    const email = `${role}-${crypto.randomUUID().slice(0, 8)}@admin.example.test`;
    const [a] = await b.owner<{ id: string }[]>`INSERT INTO platform_admins (email, name, role, password_hash) VALUES (${email}, ${role}, ${role}, 'x') RETURNING id`;
    const [s] = await b.owner<{ f: string }[]>`SELECT sa_admin_session_create(${a!.id}, ${crypto.randomUUID()}, now() + interval '1 day', '127.0.0.1', 'test') AS f`;
    const token = await signAdminToken(cfg.adminJwtSecret, { sub: a!.id, typ: "sa", sid: s!.f }, 900);
    return { id: a!.id, email, token, h: { authorization: `Bearer ${token}` } };
  };
  const call = (method: string, path: string, h: Record<string, string> | null, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...(h ?? {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, cfg, db, admin, call, close: async () => { limiter.close(); await db.end({ timeout: 2 }); } };
}
export type AdminBooted = Awaited<ReturnType<typeof bootAdminOn>>;
