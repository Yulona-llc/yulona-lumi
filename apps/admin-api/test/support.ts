import { createDb, type Db } from "@yulona/db";
import { setupTestDb, testUrls } from "@yulona/db/testing";
import { MockEmailProvider, createMockProviders } from "@yulona/providers";
import { createLogger } from "@yulona/shared";
import { createAdminApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { MemoryRateLimiter } from "../src/ratelimit";
import { hashPassword, signAdminToken } from "../src/security";

export const hasDb = !!testUrls();
export const ADMIN_SECRET = "Zq8Lw3RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0Wk3Jv9sXp";
export const CUSTOMER_SECRET = "k3Jv9sLq2XwZp7RtYb4NhGd8MfUa6CeQ1VoTi5SxEz0W";
export const WEB_ORIGIN = "http://localhost:5180";
export const ENC_KEY = Buffer.alloc(32, 9).toString("base64");
export const PASSWORD = "correct horse battery staple";
export const uniq = (p = "x") => `${p}-${crypto.randomUUID().slice(0, 8)}`;

export function adminDbUrl(ownerUrl: string): string {
  const u = new URL(ownerUrl);
  u.username = "yulona_admin";
  u.password = "yulona_admin";
  return u.toString();
}

export function adminCfg(over: Record<string, string> = {}, patch: (c: Config) => void = () => {}): Config {
  const urls = testUrls();
  const cfg = loadConfig({
    NODE_ENV: "test", ADMIN_JWT_SECRET: ADMIN_SECRET, ADMIN_DB_URL: urls ? adminDbUrl(urls.owner) : "postgres://x:y@localhost:1/x",
    ADMIN_WEB_ORIGIN: WEB_ORIGIN, ENCRYPTION_KEY: ENC_KEY, LOG_LEVEL: "silent", ADMIN_CUSTOMER_APP_URL: "https://app.example.test", ...over,
  });
  patch(cfg);
  return cfg;
}

export interface BootOpts { env?: Record<string, string>; patch?: (c: Config) => void; realLimits?: boolean }

/** Admin app on the test database, connected as the real `yulona_admin` role (no table grants). */
export async function bootAdmin(opts: BootOpts = {}) {
  const t = await setupTestDb();
  await t.owner.unsafe(`ALTER ROLE yulona_admin LOGIN PASSWORD 'yulona_admin'`);
  const db: Db = createDb(adminDbUrl(t.urls.owner), { max: 5 });
  const limiter = new MemoryRateLimiter();
  const log = createLogger({ level: "silent" });
  const email = new MockEmailProvider();
  const cfg = adminCfg(opts.env, (c) => {
    if (!opts.realLimits) {
      c.rateLimits.read = { limit: 1e7, windowMs: 60_000 };
      c.rateLimits.write = { limit: 1e7, windowMs: 60_000 };
      c.rateLimits.loginIp = { limit: 1e7, windowMs: 60_000 };
      c.rateLimits.loginIpEmail = { limit: 1e7, windowMs: 60_000 };
      c.rateLimits.twoFactor = { limit: 1e7, windowMs: 60_000 };
    }
    opts.patch?.(c);
  });
  const app = createAdminApp({ cfg, db, limiter, log, providers: { ...createMockProviders(), email } });
  return {
    app, cfg, db, owner: t.owner, appDb: t.app, limiter, email, urls: t.urls,
    close: async () => { limiter.close(); await db.end({ timeout: 2 }); await t.app.end({ timeout: 2 }); await t.owner.end({ timeout: 2 }); },
  };
}
export type AdminBoot = Awaited<ReturnType<typeof bootAdmin>>;

export interface TestAdmin { id: string; email: string; token: string; h: Record<string, string>; role: string }
/** Insert an admin and a live session directly (no login round trip), returning a signed access token. */
export async function mkAdmin(b: AdminBoot, role: "owner" | "support" | "billing" = "owner", opts: { password?: string; mustChange?: boolean } = {}): Promise<TestAdmin> {
  const email = `${uniq(role)}@admin.example.test`;
  const hash = opts.password ? await hashPassword(opts.password) : "x";
  const [a] = await b.owner<{ id: string }[]>`
    INSERT INTO platform_admins (email, name, role, password_hash, must_change_password) VALUES (${email}, ${`Admin ${role}`}, ${role}, ${hash}, ${opts.mustChange ?? false}) RETURNING id`;
  const [s] = await b.owner<{ f: string }[]>`SELECT sa_admin_session_create(${a!.id}, ${uniq("rt")}, now() + interval '1 day', '127.0.0.1', 'test') AS f`;
  const token = await signAdminToken(b.cfg.adminJwtSecret, { sub: a!.id, typ: "sa", sid: s!.f }, 900);
  return { id: a!.id, email, token, h: { authorization: `Bearer ${token}` }, role };
}

export const call = (b: AdminBoot, method: string, path: string, who: { h: Record<string, string> } | null, body?: unknown, extra: Record<string, string> = {}) =>
  b.app.request(`/api/v1${path}`, {
    method, headers: { ...(who?.h ?? {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const jsonOf = async <T = any>(r: Response): Promise<T> => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

export function cookieOf(res: Response, name = "yl_admin_rt"): string | undefined {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    if (pair!.startsWith(`${name}=`)) return pair!.slice(name.length + 1);
  }
  return undefined;
}

/** A customer workspace with an owner (and optionally extra rows) created as the DB owner. */
export async function mkTenant(b: AdminBoot, label = "cust", plan = "pro") {
  const id = uniq(label);
  const [t] = await b.owner<{ id: string }[]>`INSERT INTO tenants (name, plan_key) VALUES (${`Acme ${id}`}, ${plan}) RETURNING id`;
  const email = `owner-${id}@customer.example.test`;
  const [u] = await b.owner<{ id: string }[]>`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t!.id}, ${email}, 'Olive Owner', 'owner', 'x') RETURNING id`;
  return { tenantId: t!.id, userId: u!.id, email, name: `Acme ${id}` };
}
