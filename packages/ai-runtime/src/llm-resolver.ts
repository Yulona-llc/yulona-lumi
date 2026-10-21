import type { Db } from "@yulona/db";
import { decryptJson } from "@yulona/crypto";
import { OpenAiLlmProvider, ProviderError, createProvidersFromEnv, type LlmProvider } from "@yulona/providers";
import type { AiPorts } from "./ports";
import { portsFromProviders } from "./providers-adapter";
import { assertSafeUrl, type Resolver } from "./ssrf";

type Env = Record<string, string | undefined>;

/** A platform LLM profile row as returned by `llm_profile_resolve()` (credentials still encrypted). */
export interface ProfileRow {
  id: string;
  name: string;
  baseUrl: string;
  authHeader: string;
  authScheme: "bearer" | "raw" | "none";
  extraHeaders: Record<string, string>;
  queryParams: Record<string, string>;
  chatPath: string;
  credentialsEncrypted: string | null;
  defaultModel: string;
  enabledModels: string[];
}

export interface ResolvedLlm {
  provider: LlmProvider;
  /** null = the env provider */
  profileId: string | null;
  defaultModel?: string;
  /** models agents may use; null = unrestricted (env provider) */
  enabledModels: string[] | null;
}

/** Resolves the LLM to use per call (platform profile in SaaS, env otherwise). */
export interface LlmResolver {
  resolve(): Promise<ResolvedLlm>;
  /** drop the cache (profile changed in this process) */
  invalidate(): void;
}

export const profileAad = (id: string) => `llmprofile:${id}`;

/** Build the provider for a profile: decrypts the key, validates the URL against SSRF rules. */
export async function buildProfileProvider(
  p: ProfileRow, o: { encryptionKey?: string; dnsResolver?: Resolver; allowPrivate?: boolean; fetch?: typeof fetch; timeoutMs?: number; maxRetries?: number },
): Promise<LlmProvider> {
  if (!o.allowPrivate) await assertSafeUrl(p.baseUrl, o.dnsResolver);
  let apiKey = "";
  if (p.credentialsEncrypted) {
    if (!o.encryptionKey) throw new ProviderError("ENCRYPTION_KEY is not set; cannot decrypt the provider credentials", "llm-profile", false);
    try {
      apiKey = decryptJson<{ apiKey?: string }>(o.encryptionKey, p.credentialsEncrypted, profileAad(p.id)).apiKey ?? "";
    } catch {
      throw new ProviderError("provider credentials could not be decrypted", "llm-profile", false);
    }
  }
  return new OpenAiLlmProvider({
    apiKey, baseUrl: p.baseUrl, model: p.defaultModel, authHeader: p.authHeader, authScheme: p.authScheme,
    extraHeaders: p.extraHeaders, queryParams: p.queryParams, chatPath: p.chatPath, fetch: o.fetch, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries,
  });
}

export interface LlmResolverOptions {
  db?: Db;
  mode: "saas" | "selfhosted";
  encryptionKey?: string;
  env?: Env;
  /** profile cache, default 30 s */
  ttlMs?: number;
  dnsResolver?: Resolver;
  fetch?: typeof fetch;
}

export function createLlmResolver(o: LlmResolverOptions): LlmResolver {
  const env = o.env ?? process.env;
  const ttl = o.ttlMs ?? 30_000;
  let envLlm: LlmProvider | undefined;
  const fromEnv = (): ResolvedLlm => ({ provider: (envLlm ??= createProvidersFromEnv(env).llm), profileId: null, enabledModels: null });
  let cached: { at: number; value: ResolvedLlm } | undefined;
  let inflight: Promise<ResolvedLlm> | undefined;

  async function load(): Promise<ResolvedLlm> {
    const [row] = await o.db!<ProfileRow[]>`SELECT * FROM llm_profile_resolve(NULL)`;
    if (!row) return fromEnv();
    const provider = await buildProfileProvider(row, { encryptionKey: o.encryptionKey, dnsResolver: o.dnsResolver, fetch: o.fetch });
    return { provider, profileId: row.id, defaultModel: row.defaultModel, enabledModels: row.enabledModels ?? [] };
  }

  return {
    async resolve() {
      if (o.mode === "selfhosted" || !o.db) return fromEnv();
      if (cached && Date.now() - cached.at < ttl) return cached.value;
      inflight ??= load().then((value) => { cached = { at: Date.now(), value }; return value; }).finally(() => { inflight = undefined; });
      return inflight;
    },
    invalidate() { cached = undefined; },
  };
}

/** `AiPorts` whose LLM is resolved per call; enforces the profile's enabled-model list (falls back to the default model). */
export function portsFromResolver(resolver: LlmResolver): AiPorts {
  return {
    llm: {
      async chat(req) {
        const r = await resolver.resolve();
        let model = req.model;
        let modelFallback: { requested: string; used: string } | undefined;
        if (r.profileId && r.defaultModel) {
          const allowed = new Set([r.defaultModel, ...(r.enabledModels ?? [])]);
          if (!model || !allowed.has(model)) {
            if (model) modelFallback = { requested: model, used: r.defaultModel };
            model = r.defaultModel;
          }
        }
        const res = await portsFromProviders({ llm: r.provider }).llm.chat({ ...req, model });
        return { ...res, model: res.model ?? model, profileId: r.profileId, ...(modelFallback ? { modelFallback } : {}) };
      },
    },
  };
}
