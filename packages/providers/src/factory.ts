import {
  ConsoleEmailProvider, MemoryStorageProvider, MockCalendarProvider, MockLlmProvider,
  StubBillingProvider,
} from "./mock";
import { OpenAiLlmProvider, type OpenAiOptions } from "./openai";
import { ClamAvHttpScanner, S3StorageProvider } from "./s3";
import { SmtpEmailProvider } from "./smtp";
import { stripeFromEnv } from "./stripe";
import type { Providers } from "./types";

type Env = Record<string, string | undefined>;

function jsonMap(env: Env, key: string): Record<string, string> | undefined {
  const raw = env[key];
  if (!raw) return undefined;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error(`${key} must be a JSON object of strings`); }
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) throw new Error(`${key} must be a JSON object of strings`);
  return v as Record<string, string>;
}

/** Auth/transport options for any OpenAI-compatible service, from env. */
export function openAiCompatOptionsFromEnv(env: Env): Pick<OpenAiOptions, "authHeader" | "authScheme" | "extraHeaders" | "queryParams" | "chatPath"> {
  const scheme = env.AI_AUTH_SCHEME;
  if (scheme && !["bearer", "raw", "none"].includes(scheme)) throw new Error("AI_AUTH_SCHEME must be bearer, raw or none");
  return {
    authHeader: env.AI_AUTH_HEADER || undefined, authScheme: (scheme || undefined) as OpenAiOptions["authScheme"],
    extraHeaders: jsonMap(env, "AI_EXTRA_HEADERS"), queryParams: jsonMap(env, "AI_QUERY"), chatPath: env.AI_CHAT_PATH || undefined,
  };
}

/**
 * Build providers from env.
 * AI_PROVIDER = openai | deepseek | mock (default: openai when AI_API_KEY is set, else mock).
 *  - deepseek: OpenAI-compatible chat API (AI_BASE_URL default https://api.deepseek.com, AI_MODEL default deepseek-chat).
 * There is no embedding provider: agent knowledge is organised as skills the agent reads (see @yulona/ai-runtime).
 * Email: SMTP_HOST => smtp, else console. Storage: S3_BUCKET => s3, else in-memory (dev only).
 */
export function createProvidersFromEnv(env: Env = process.env): Providers {
  const kind = env.AI_PROVIDER ?? (env.AI_API_KEY ? "openai" : "mock");
  let llm: Providers["llm"];
  if (kind === "openai") {
    if (!env.AI_API_KEY && env.AI_AUTH_SCHEME !== "none") throw new Error("AI_PROVIDER=openai requires AI_API_KEY");
    llm = new OpenAiLlmProvider({ apiKey: env.AI_API_KEY ?? "", baseUrl: env.AI_BASE_URL, model: env.AI_MODEL ?? "gpt-4o-mini", ...openAiCompatOptionsFromEnv(env) });
  } else if (kind === "deepseek") {
    if (!env.AI_API_KEY && env.AI_AUTH_SCHEME !== "none") throw new Error("AI_PROVIDER=deepseek requires AI_API_KEY");
    llm = new OpenAiLlmProvider({ apiKey: env.AI_API_KEY ?? "", baseUrl: env.AI_BASE_URL || "https://api.deepseek.com", model: env.AI_MODEL || "deepseek-chat", ...openAiCompatOptionsFromEnv(env) });
  } else if (kind === "mock") {
    llm = new MockLlmProvider();
  } else {
    throw new Error(`Unknown AI_PROVIDER "${kind}" (supported: openai, deepseek, mock)`);
  }
  const email = env.SMTP_HOST
    ? new SmtpEmailProvider({
        host: env.SMTP_HOST, port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined, user: env.SMTP_USER, pass: env.SMTP_PASS,
        secure: env.SMTP_SECURE === "true", from: env.EMAIL_FROM ?? "Lumi <no-reply@localhost>",
      })
    : new ConsoleEmailProvider();
  const storage = env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? new S3StorageProvider({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY })
    : new MemoryStorageProvider();
  return {
    llm, email, storage,
    calendar: new MockCalendarProvider(), // Google provider arrives with the bookings wave
    billing: stripeFromEnv(env) ?? new StubBillingProvider(), // Stripe when STRIPE_SECRET_KEY is set
    virusScanner: env.CLAMAV_URL ? new ClamAvHttpScanner(env.CLAMAV_URL) : undefined,
  };
}

/** All-mock providers for tests. */
export function createMockProviders(): Providers & { llm: MockLlmProvider } {
  return {
    llm: new MockLlmProvider(), email: new ConsoleEmailProvider(() => {}),
    storage: new MemoryStorageProvider(), calendar: new MockCalendarProvider(), billing: new StubBillingProvider(),
  };
}
