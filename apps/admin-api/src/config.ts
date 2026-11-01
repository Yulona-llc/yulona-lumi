import { isIP } from "node:net";
import { z } from "zod";
import type { LogLevel } from "@yulona/shared";

const bool = (def: boolean) => z.enum(["true", "false"]).default(def ? "true" : "false").transform((v) => v === "true");
const empty = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_PORT: z.preprocess(empty, z.coerce.number().int().min(1).max(65535).optional()),
  PORT: z.preprocess(empty, z.coerce.number().int().min(1).max(65535).optional()),
  /** Own signing secret. Never the customer JWT_SECRET. */
  ADMIN_JWT_SECRET: z.string().min(1, "ADMIN_JWT_SECRET is required").pipe(z.string().min(32, "ADMIN_JWT_SECRET must be at least 32 characters")),
  /** Only read to refuse starting when both are equal; the admin service never needs the customer secret. */
  JWT_SECRET: z.string().optional(),
  ADMIN_DB_URL: z.preprocess(empty, z.string().optional()),
  ADMIN_DB_PASSWORD: z.preprocess(empty, z.string().optional()),
  DATABASE_URL: z.preprocess(empty, z.string().optional()),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  REDIS_URL: z.preprocess(empty, z.string().optional()),
  ADMIN_WEB_ORIGIN: z.preprocess(empty, z.string().optional()),
  ADMIN_ALLOWED_CIDRS: z.string().default(""),
  ADMIN_REQUIRE_2FA: bool(false),
  ADMIN_CUSTOMER_APP_URL: z.preprocess(empty, z.string().optional()),
  ADMIN_RATE_READ: z.coerce.number().int().min(1).max(100000).default(30),
  ADMIN_RATE_WRITE: z.coerce.number().int().min(1).max(100000).default(10),
  ADMIN_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  TRUST_PROXY: bool(false),
  DEPLOYMENT_MODE: z.enum(["saas", "selfhosted"]).default("saas"),
  ENCRYPTION_KEY: z.preprocess(empty, z.string().optional()),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(256 * 1024),
});

export interface RateLimitRule { limit: number; windowMs: number }
export interface Config {
  env: "development" | "test" | "production";
  isProd: boolean;
  port: number;
  adminJwtSecret: string;
  databaseUrl: string;
  dbPoolMax: number;
  redisUrl?: string;
  /** The only origin allowed by CORS (the admin web app). */
  webOrigin: string;
  allowedCidrs: string[];
  require2fa: boolean;
  customerAppUrl: string;
  trustProxy: boolean;
  deploymentMode: "saas" | "selfhosted";
  encryptionKey?: string;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  cookieName: string;
  cookieSecure: boolean;
  accessTokenTtlSeconds: number;
  sessionTtlDays: number;
  rateLimits: { read: RateLimitRule; write: RateLimitRule; loginIp: RateLimitRule; loginIpEmail: RateLimitRule; twoFactor: RateLimitRule };
}

const WEAK = /change.?me|secret|password|example|default|test|dev|0000|1234|xxxx|placeholder/i;

export function validateCidr(c: string): boolean {
  const [ip, bits, ...rest] = c.trim().split("/");
  if (rest.length || !ip) return false;
  const fam = isIP(ip);
  if (!fam) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (fam === 4 ? 32 : 128);
}

/** Throws with an actionable message when the production configuration is unsafe. */
export function assertProductionSafe(c: Pick<Config, "adminJwtSecret" | "databaseUrl" | "isProd" | "webOrigin">): void {
  if (!c.isProd) return;
  const problems: string[] = [];
  if (c.adminJwtSecret.length < 32 || new Set(c.adminJwtSecret).size < 12 || WEAK.test(c.adminJwtSecret)) {
    problems.push("ADMIN_JWT_SECRET is weak (need >=32 chars, high entropy, no placeholder words; try `openssl rand -base64 48`)");
  }
  if (/\/\/yulona_(app|owner|admin):yulona_(app|owner|admin)@/.test(c.databaseUrl)) problems.push("the admin database URL uses a development default password");
  if (/\/\/[^:@/]+@/.test(c.databaseUrl) || !/\/\/[^:@/]+:[^@]+@/.test(c.databaseUrl)) problems.push("the admin database URL must include a password");
  if (!c.webOrigin || c.webOrigin === "*" || !/^https:\/\//.test(c.webOrigin)) problems.push("ADMIN_WEB_ORIGIN must be the https origin of the admin web app");
  if (problems.length) throw new Error("Refusing to start in production:\n - " + problems.join("\n - "));
}

/** Derive the admin DB URL: ADMIN_DB_URL, or DATABASE_URL's host/database with user yulona_admin and ADMIN_DB_PASSWORD. */
function adminDbUrl(e: z.infer<typeof envSchema>): string {
  if (e.ADMIN_DB_URL) return e.ADMIN_DB_URL;
  if (e.DATABASE_URL && e.ADMIN_DB_PASSWORD) {
    const u = new URL(e.DATABASE_URL);
    u.username = "yulona_admin";
    u.password = e.ADMIN_DB_PASSWORD;
    return u.toString();
  }
  throw new Error("Invalid environment: set ADMIN_DB_URL, or DATABASE_URL (host and database) together with ADMIN_DB_PASSWORD");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  if (e.JWT_SECRET && e.JWT_SECRET === e.ADMIN_JWT_SECRET) {
    throw new Error("Invalid environment: ADMIN_JWT_SECRET must differ from JWT_SECRET (separate signing realms)");
  }
  const isProd = e.NODE_ENV === "production";
  const cidrs = e.ADMIN_ALLOWED_CIDRS.split(",").map((s) => s.trim()).filter(Boolean);
  const badCidr = cidrs.filter((c) => !validateCidr(c));
  if (badCidr.length) throw new Error(`Invalid environment: ADMIN_ALLOWED_CIDRS has invalid entries: ${badCidr.join(", ")}`);
  const cfg: Config = {
    env: e.NODE_ENV,
    isProd,
    port: e.ADMIN_PORT ?? e.PORT ?? 4100,
    adminJwtSecret: e.ADMIN_JWT_SECRET,
    databaseUrl: adminDbUrl(e),
    dbPoolMax: e.DB_POOL_MAX,
    redisUrl: e.REDIS_URL,
    webOrigin: (e.ADMIN_WEB_ORIGIN ?? (isProd ? "" : "http://localhost:5178")).replace(/\/+$/, ""),
    allowedCidrs: cidrs,
    require2fa: e.ADMIN_REQUIRE_2FA,
    customerAppUrl: (e.ADMIN_CUSTOMER_APP_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    trustProxy: e.TRUST_PROXY,
    deploymentMode: e.DEPLOYMENT_MODE,
    encryptionKey: e.ENCRYPTION_KEY,
    logLevel: e.LOG_LEVEL,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    cookieName: "yl_admin_rt",
    cookieSecure: isProd,
    accessTokenTtlSeconds: 900,
    sessionTtlDays: e.ADMIN_SESSION_TTL_DAYS,
    rateLimits: {
      read: { limit: e.ADMIN_RATE_READ, windowMs: 60_000 },
      write: { limit: e.ADMIN_RATE_WRITE, windowMs: 60_000 },
      loginIp: { limit: 40, windowMs: 15 * 60_000 },
      loginIpEmail: { limit: 8, windowMs: 15 * 60_000 },
      twoFactor: { limit: 8, windowMs: 15 * 60_000 },
    },
  };
  assertProductionSafe(cfg);
  return cfg;
}
