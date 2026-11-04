import { z } from "zod";
import type { LogLevel } from "@yulona/shared";

const bool = (def: boolean) =>
  z.enum(["true", "false"]).default(def ? "true" : "false").transform((v) => v === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CORS_ORIGINS: z.string().default(""),
  ALLOW_PUBLIC_SIGNUP: bool(false),
  CROSS_SITE_COOKIES: bool(false),
  TRUST_PROXY: bool(false),
  /** saas (default): multi-tenant, billing on. selfhosted: single tenant, no billing. */
  DEPLOYMENT_MODE: z.enum(["saas", "selfhosted"]).default("saas"),
  APP_URL: z.string().default("http://localhost:5173"),
  OPENAPI_ENABLED: z.enum(["true", "false"]).optional(),
  DOCS_USERNAME: z.string().default("docs"),
  DOCS_PASSWORD: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // conversations
  ENCRYPTION_KEY: z.string().optional(),
  PUBLIC_API_URL: z.string().optional(),
  WIDGET_SCRIPT_URL: z.string().optional(),
  WIDGET_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** optional cheaper model for the "Ask Lumi" copilot (must be enabled on the LLM profile in SaaS) */
  COPILOT_MODEL: z.string().trim().max(100).optional(),
});

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}
export interface Config {
  env: "development" | "test" | "production";
  isProd: boolean;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  redisUrl?: string;
  jwtSecret: string;
  corsOrigins: string[];
  allowPublicSignup: boolean;
  crossSiteCookies: boolean;
  cookieSecure: boolean;
  trustProxy: boolean;
  deploymentMode: "saas" | "selfhosted";
  /** false in selfhosted mode: billing routes are not mounted (no Stripe, no plan upsell). */
  billingEnabled: boolean;
  appUrl: string;
  openapiEnabled: boolean;
  /** HTTP basic auth for /docs and /api/v1/openapi.json. Unset means the docs are not mounted. */
  docsUsername: string;
  docsPassword?: string;
  logLevel: LogLevel;
  bodyLimitBytes: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** conversations */
  encryptionKey?: string;
  publicApiUrl?: string;
  widgetScriptUrl: string;
  widgetSessionTtlHours: number;
  /** model override for the Ask Lumi copilot (undefined = the provider default) */
  copilotModel?: string;
  /** Cloudflare Turnstile siteverify endpoint (a constant; tests point it at a fake server). */
  turnstileVerifyUrl: string;
  rateLimits: { global: RateLimitRule; loginIpEmail: RateLimitRule; loginIp: RateLimitRule; register: RateLimitRule; refresh: RateLimitRule; docs: RateLimitRule };
}

const WEAK_SECRET = /change.?me|secret|password|example|default|test|dev|0000|1234|xxxx|placeholder/i;

/** Throws with an actionable message if the production configuration is unsafe. */
export function assertProductionSafe(c: Pick<Config, "jwtSecret" | "databaseUrl" | "corsOrigins" | "isProd" | "openapiEnabled" | "docsPassword">): void {
  if (!c.isProd) return;
  const problems: string[] = [];
  if (c.jwtSecret.length < 32 || new Set(c.jwtSecret).size < 12 || WEAK_SECRET.test(c.jwtSecret)) {
    problems.push("JWT_SECRET is weak (need >=32 chars, high entropy, no placeholder words; try `openssl rand -base64 48`)");
  }
  if (c.openapiEnabled && !c.docsPassword) {
    problems.push("OPENAPI_ENABLED=true requires DOCS_PASSWORD (HTTP basic auth for /docs; try `openssl rand -base64 24`)");
  }
  if (/\/\/yulona_(app|owner):yulona_(app|owner)@/.test(c.databaseUrl)) {
    problems.push("DATABASE_URL uses the development default password");
  }
  if (/\/\/[^:@/]+@/.test(c.databaseUrl) || !/\/\/[^:@/]+:[^@]+@/.test(c.databaseUrl)) {
    problems.push("DATABASE_URL must include a password");
  }
  if (c.corsOrigins.includes("*")) problems.push("CORS_ORIGINS must not contain '*'");
  if (problems.length) throw new Error("Refusing to start in production:\n - " + problems.join("\n - "));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  const selfhosted = e.DEPLOYMENT_MODE === "selfhosted";
  const docsUsername = e.DOCS_USERNAME.trim();
  const docsPassword = e.DOCS_PASSWORD?.trim() || undefined;
  if (!docsUsername || docsUsername.length > 64 || docsUsername.includes(":")) {
    throw new Error("Invalid environment: DOCS_USERNAME must be 1-64 characters and must not contain ':'");
  }
  if (docsPassword && (docsPassword.length < 16 || WEAK_SECRET.test(docsPassword))) {
    throw new Error("Invalid environment: DOCS_PASSWORD is weak (need >=16 chars, high entropy, no placeholder words; try `openssl rand -base64 24`)");
  }
  const cfg: Config = {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    redisUrl: e.REDIS_URL || undefined,
    jwtSecret: e.JWT_SECRET,
    corsOrigins: (e.CORS_ORIGINS || (isProd ? "" : "http://localhost:5173,http://127.0.0.1:5173"))
      .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    // selfhosted = exactly one tenant, created by deploy/setup.sh (create-tenant script): open signup is never allowed.
    allowPublicSignup: selfhosted ? false : e.ALLOW_PUBLIC_SIGNUP,
    crossSiteCookies: e.CROSS_SITE_COOKIES,
    cookieSecure: isProd || e.CROSS_SITE_COOKIES,
    trustProxy: e.TRUST_PROXY,
    deploymentMode: e.DEPLOYMENT_MODE,
    billingEnabled: !selfhosted,
    appUrl: e.APP_URL,
    openapiEnabled: e.OPENAPI_ENABLED ? e.OPENAPI_ENABLED === "true" : !isProd,
    docsUsername,
    docsPassword,
    logLevel: e.LOG_LEVEL,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    encryptionKey: e.ENCRYPTION_KEY || undefined,
    publicApiUrl: e.PUBLIC_API_URL?.replace(/\/+$/, "") || undefined,
    // A relative "/widget.js" only works on the dashboard's own origin; on customers' sites the embed snippet needs an absolute URL.
    widgetScriptUrl: e.WIDGET_SCRIPT_URL || (env.APP_URL ? `${env.APP_URL.replace(/\/+$/, "")}/widget.js` : "/widget.js"),
    widgetSessionTtlHours: e.WIDGET_SESSION_TTL_HOURS,
    copilotModel: e.COPILOT_MODEL || undefined,
    turnstileVerifyUrl: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    rateLimits: {
      global: { limit: 300, windowMs: 60_000 },
      loginIpEmail: { limit: 8, windowMs: 15 * 60_000 },
      loginIp: { limit: 40, windowMs: 15 * 60_000 },
      register: { limit: 10, windowMs: 60 * 60_000 },
      refresh: { limit: 60, windowMs: 60_000 },
      docs: { limit: 30, windowMs: 15 * 60_000 },
    },
  };
  assertProductionSafe(cfg);
  return cfg;
}
