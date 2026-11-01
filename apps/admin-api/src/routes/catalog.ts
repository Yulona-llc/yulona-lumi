// Platform catalogue: plans and limits, feature flags, model rates, credit packs, LLM provider profiles.
// Reads and writes go through sa_* functions (the admin DB role has no table grants).
import { z } from "zod";
import { SsrfError, assertSafeUrl, buildProfileProvider, profileAad, type ProfileRow } from "@yulona/ai-runtime";
import { decryptJson, encryptJson } from "@yulona/crypto";
import type { Deps } from "../context";
import { AppError, Errors } from "../errors";
import { isFkViolation, isUniqueViolation, iso, parseBody, parseId, parseQuery } from "../http";
import { ALL, OWNER, OWNER_BILLING, type Registrar } from "../route";
import { flagKeySchema, planKey } from "./tenants";

export const LIMIT_METRICS = ["seats", "agents", "widgets", "api_keys", "monthly_conversations", "storage_mb", "llm_tokens_monthly", "llm_credits_monthly", "copilot_credits_monthly"] as const;

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie", "content-type", "upgrade"]);
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name");
const extraHeaders = z.record(headerName, z.string().max(1024)).refine((o) => Object.keys(o).length <= 20, "At most 20 headers")
  .refine((o) => Object.keys(o).every((k) => !FORBIDDEN_HEADERS.has(k.toLowerCase())), "Header not allowed");
const queryParams = z.record(z.string().regex(/^[A-Za-z0-9_.\-[\]]{1,64}$/, "Invalid query key"), z.string().max(256))
  .refine((o) => Object.keys(o).length <= 20, "At most 20 query params");
const chatPath = z.string().max(200).regex(/^\/[A-Za-z0-9._~\/-]*$/, "Must start with / and contain only path characters")
  .refine((p) => !p.includes("//") && !p.split("/").includes(".."), "Invalid path");

export const profileBase = {
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url().max(500),
  authHeader: headerName.refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), "Header not allowed"),
  authScheme: z.enum(["bearer", "raw", "none"]),
  extraHeaders, queryParams, chatPath,
  defaultModel: z.string().trim().min(1).max(120),
  enabledModels: z.array(z.string().trim().min(1).max(120)).max(100),
  isDefault: z.boolean(),
  enabled: z.boolean(),
};
export const createProfileSchema = z.strictObject({
  name: profileBase.name, baseUrl: profileBase.baseUrl, defaultModel: profileBase.defaultModel,
  apiKey: z.string().min(1).max(4096).optional(),
  authHeader: profileBase.authHeader.optional(), authScheme: profileBase.authScheme.optional(),
  extraHeaders: extraHeaders.optional(), queryParams: queryParams.optional(), chatPath: chatPath.optional(),
  enabledModels: profileBase.enabledModels.optional(), isDefault: z.boolean().optional(), enabled: z.boolean().optional(),
});
export const updateProfileSchema = z.strictObject({
  name: profileBase.name.optional(), baseUrl: profileBase.baseUrl.optional(), defaultModel: profileBase.defaultModel.optional(),
  apiKey: z.string().min(1).max(4096).nullable().optional(),
  authHeader: profileBase.authHeader.optional(), authScheme: profileBase.authScheme.optional(),
  extraHeaders: extraHeaders.optional(), queryParams: queryParams.optional(), chatPath: chatPath.optional(),
  enabledModels: profileBase.enabledModels.optional(), isDefault: z.boolean().optional(), enabled: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, "At least one field required");
export const modelRateSchema = z.strictObject({
  model: z.string().trim().regex(/^(\*|[\w.:/@+-]{1,120})$/, "Invalid model"),
  inputMicroPer1k: z.number().int().min(0).max(1e12),
  outputMicroPer1k: z.number().int().min(0).max(1e12),
  enabled: z.boolean().optional(),
});
const packFields = {
  name: z.string().trim().min(1).max(80),
  credits: z.number().int().min(1).max(10_000_000),
  priceCents: z.number().int().min(0).max(100_000_000),
  active: z.boolean(),
  sortOrder: z.number().int().min(-1000).max(1000),
};
export const createPackSchema = z.strictObject({ ...packFields, active: packFields.active.optional(), sortOrder: packFields.sortOrder.optional() });
export const updatePackSchema = z.strictObject({
  name: packFields.name.optional(), credits: packFields.credits.optional(), priceCents: packFields.priceCents.optional(),
  active: packFields.active.optional(), sortOrder: packFields.sortOrder.optional(),
}).refine((b) => Object.keys(b).length > 0, "At least one field required");
export const grantSchema = z.strictObject({
  credits: z.number().finite().refine((v) => v !== 0, "Must not be zero").refine((v) => Math.abs(v) <= 10_000_000, "Too large"),
  reason: z.string().trim().min(3).max(300),
});


interface ProfileListRow {
  id: string; name: string; baseUrl: string; authHeader: string; authScheme: string; extraHeaders: Record<string, string>;
  queryParams: Record<string, string>; chatPath: string; defaultModel: string; enabledModels: string[]; isDefault: boolean; enabled: boolean;
  hasCredentials: boolean; createdAt: Date; updatedAt: Date;
}
const profileDto = (p: ProfileListRow) => ({
  id: p.id, name: p.name, baseUrl: p.baseUrl, authHeader: p.authHeader, authScheme: p.authScheme, extraHeaders: p.extraHeaders, queryParams: p.queryParams,
  chatPath: p.chatPath, defaultModel: p.defaultModel, enabledModels: p.enabledModels, isDefault: p.isDefault, enabled: p.enabled,
  hasCredentials: p.hasCredentials, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt),
});

export function registerCatalogRoutes(reg: Registrar, d: Deps) {
  const { cfg, db, fetchImpl, dnsResolver } = d;
  const selfhosted = cfg.deploymentMode === "selfhosted";

  // ---------------------------------------------------------------- plans
  reg.route({ method: "GET", path: "/plans", roles: ALL, tag: "Plans and flags", summary: "Plans and their limits" }, async (c) => {
    const rows = await db<{ key: string; name: string; metric: string | null; limitValue: string | null }[]>`SELECT * FROM sa_list_plans()`;
    const plans = new Map<string, { key: string; name: string; limits: Record<string, number | null> }>();
    for (const x of rows) {
      const p = plans.get(x.key) ?? { key: x.key, name: x.name, limits: {} };
      if (x.metric) p.limits[x.metric] = x.limitValue === null ? null : Number(x.limitValue);
      plans.set(x.key, p);
    }
    return c.json({ items: [...plans.values()] });
  });
  const limitBody = z.strictObject({ limit: z.number().int().min(0).nullable() });
  reg.route({ method: "PUT", path: "/plans/:key/limits/:metric", roles: OWNER_BILLING, tag: "Plans and flags", summary: "Set a plan limit (null = unlimited)", body: limitBody }, async (c) => {
    const key = planKey.safeParse(c.req.param("key"));
    const metric = z.enum(LIMIT_METRICS).safeParse(c.req.param("metric"));
    if (!key.success || !metric.success) throw Errors.notFound();
    const body = await parseBody(c, limitBody);
    try {
      await db`SELECT sa_set_plan_limit(${c.get("admin").id}, ${key.data}, ${metric.data}, ${body.limit})`;
    } catch (e) {
      if (isFkViolation(e)) throw Errors.notFound("Plan not found");
      throw e;
    }
    return c.json({ plan: key.data, metric: metric.data, limit: body.limit });
  });

  // ---------------------------------------------------------------- feature flags
  reg.route({ method: "GET", path: "/feature-flags", roles: ALL, tag: "Plans and flags", summary: "Global feature flags" }, async (c) => {
    const rows = await db<{ key: string; description: string; defaultEnabled: boolean }[]>`SELECT * FROM sa_list_flags()`;
    return c.json({ items: rows });
  });
  const flagBody = z.strictObject({ description: z.string().max(500).default(""), defaultEnabled: z.boolean() });
  reg.route({ method: "PUT", path: "/feature-flags/:key", roles: OWNER, tag: "Plans and flags", summary: "Create or update a global flag", body: flagBody }, async (c) => {
    const key = flagKeySchema.safeParse(c.req.param("key"));
    if (!key.success) throw Errors.notFound();
    const body = await parseBody(c, flagBody);
    await db`SELECT sa_upsert_flag(${c.get("admin").id}, ${key.data}, ${body.description}, ${body.defaultEnabled})`;
    return c.json({ key: key.data, ...body });
  });
  reg.route({ method: "DELETE", path: "/feature-flags/:key", roles: OWNER, tag: "Plans and flags", summary: "Delete a global flag" }, async (c) => {
    const key = flagKeySchema.safeParse(c.req.param("key"));
    if (!key.success) throw Errors.notFound();
    const [x] = await db<{ saDeleteFlag: boolean }[]>`SELECT sa_delete_flag(${c.get("admin").id}, ${key.data})`;
    if (!x?.saDeleteFlag) throw Errors.notFound("Flag not found");
    return c.json({ ok: true as const });
  });

  // ---------------------------------------------------------------- model rates
  reg.route({ method: "GET", path: "/model-rates", roles: ALL, tag: "Credits catalogue", summary: "Model rates (micro-credits per 1k tokens)" }, async (c) => {
    const rows = await db<{ model: string; inputMicroPer1k: string; outputMicroPer1k: string; enabled: boolean; updatedAt: Date }[]>`SELECT * FROM sa_list_model_rates()`;
    return c.json({ items: rows.map((x) => ({ model: x.model, inputMicroPer1k: Number(x.inputMicroPer1k), outputMicroPer1k: Number(x.outputMicroPer1k), enabled: x.enabled, updatedAt: iso(x.updatedAt) })) });
  });
  reg.route({ method: "PUT", path: "/model-rates", roles: OWNER_BILLING, tag: "Credits catalogue", summary: "Upsert a model rate", body: modelRateSchema }, async (c) => {
    const b = await parseBody(c, modelRateSchema);
    await db`SELECT sa_set_model_rate(${c.get("admin").id}, ${b.model}, ${b.inputMicroPer1k}, ${b.outputMicroPer1k}, ${b.enabled ?? true})`;
    return c.json({ model: b.model, inputMicroPer1k: b.inputMicroPer1k, outputMicroPer1k: b.outputMicroPer1k, enabled: b.enabled ?? true });
  });
  reg.route({ method: "DELETE", path: "/model-rates", roles: OWNER_BILLING, tag: "Credits catalogue", summary: "Delete a model rate (?model=; the * default cannot be deleted)" }, async (c) => {
    const q = parseQuery(c, z.strictObject({ model: z.string().trim().min(1).max(120) }));
    if (q.model === "*") throw Errors.validation([{ path: "model", message: "The default rate cannot be deleted" }]);
    const [res] = await db<{ saDeleteModelRate: boolean }[]>`SELECT sa_delete_model_rate(${c.get("admin").id}, ${q.model})`;
    if (!res?.saDeleteModelRate) throw Errors.notFound("Rate not found");
    return c.json({ ok: true as const });
  });

  // ---------------------------------------------------------------- credit packs
  interface PackRow { id: string; name: string; credits: string; priceCents: number; currency: string; active: boolean; sortOrder: number; createdAt: Date }
  const packDto = (p: PackRow) => ({ id: p.id, name: p.name, credits: Number(p.credits), priceCents: p.priceCents, currency: p.currency, active: p.active, sortOrder: p.sortOrder, createdAt: iso(p.createdAt) });
  const loadPack = async (id: string) => (await db<PackRow[]>`SELECT * FROM sa_list_credit_packs()`).find((p) => p.id === id);
  reg.route({ method: "GET", path: "/credit-packs", roles: ALL, tag: "Credits catalogue", summary: "Credit packs (including inactive)" }, async (c) => {
    const rows = await db<PackRow[]>`SELECT * FROM sa_list_credit_packs()`;
    return c.json({ items: rows.map(packDto) });
  });
  reg.route({ method: "POST", path: "/credit-packs", roles: OWNER_BILLING, tag: "Credits catalogue", summary: "Create a credit pack", body: createPackSchema, status: 201 }, async (c) => {
    const b = await parseBody(c, createPackSchema);
    const [res] = await db<{ saUpsertCreditPack: string }[]>`
      SELECT sa_upsert_credit_pack(${c.get("admin").id}, NULL, ${b.name}, ${b.credits}, ${b.priceCents}, ${b.active ?? true}, ${b.sortOrder ?? 0})`;
    return c.json(packDto((await loadPack(res!.saUpsertCreditPack))!), 201);
  });
  reg.route({ method: "PATCH", path: "/credit-packs/:id", roles: OWNER_BILLING, tag: "Credits catalogue", summary: "Update a credit pack", body: updatePackSchema }, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, updatePackSchema);
    const cur = await loadPack(id);
    if (!cur) throw Errors.notFound("Pack not found");
    await db`
      SELECT sa_upsert_credit_pack(${c.get("admin").id}, ${id}, ${b.name ?? cur.name}, ${b.credits ?? Number(cur.credits)}, ${b.priceCents ?? cur.priceCents},
        ${b.active ?? cur.active}, ${b.sortOrder ?? cur.sortOrder})`;
    return c.json(packDto((await loadPack(id))!));
  });
  reg.route({ method: "DELETE", path: "/credit-packs/:id", roles: OWNER_BILLING, tag: "Credits catalogue", summary: "Delete (or deactivate when already purchased) a credit pack" }, async (c) => {
    const [res] = await db<{ saDeleteCreditPack: string }[]>`SELECT sa_delete_credit_pack(${c.get("admin").id}, ${parseId(c)})`;
    if (res?.saDeleteCreditPack === "missing") throw Errors.notFound("Pack not found");
    return c.json({ ok: true as const, result: res!.saDeleteCreditPack });
  });

  // ---------------------------------------------------------------- LLM provider profiles
  /** Profile URLs follow the SSRF rules; private hosts are only acceptable on self-hosted. HTTPS is required in SaaS. */
  async function checkUrl(raw: string) {
    try {
      const u = new URL(raw);
      if (u.search || u.hash) throw new SsrfError("base URL must not carry a query string (use queryParams)");
      if (!selfhosted) {
        if (u.protocol !== "https:") throw new SsrfError("only https URLs are allowed");
        await assertSafeUrl(raw, dnsResolver);
      } else if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("only http/https URLs are allowed");
      else if (u.username || u.password) throw new SsrfError("URLs with credentials are not allowed");
    } catch (e) {
      if (e instanceof SsrfError) throw Errors.validation([{ path: "baseUrl", message: e.message }]);
      throw e;
    }
  }
  const sealKey = (id: string, apiKey: string) => {
    if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "ENCRYPTION_KEY is not configured; cannot store provider credentials");
    return encryptJson(cfg.encryptionKey, { apiKey }, profileAad(id));
  };
  const getProfile = async (id: string) => (await db<ProfileListRow[]>`SELECT * FROM sa_list_llm_profiles()`).find((p) => p.id === id);

  reg.route({ method: "GET", path: "/llm-profiles", roles: ALL, tag: "Providers", summary: "LLM provider profiles (never returns keys)" }, async (c) => {
    const rows = await db<ProfileListRow[]>`SELECT * FROM sa_list_llm_profiles()`;
    return c.json({ items: rows.map(profileDto) });
  });
  reg.route({ method: "GET", path: "/llm-profiles/:id", roles: ALL, tag: "Providers", summary: "One provider profile" }, async (c) => {
    const p = await getProfile(parseId(c));
    if (!p) throw Errors.notFound("Profile not found");
    return c.json(profileDto(p));
  });
  reg.route({ method: "POST", path: "/llm-profiles", roles: OWNER, tag: "Providers", summary: "Create a provider profile (SSRF-checked URL, key encrypted)", body: createProfileSchema, status: 201 }, async (c) => {
    const b = await parseBody(c, createProfileSchema);
    await checkUrl(b.baseUrl);
    const id = crypto.randomUUID();
    const creds = b.apiKey ? sealKey(id, b.apiKey) : null;
    try {
      await db`
        SELECT sa_create_llm_profile(${c.get("admin").id}, ${id}, ${b.name}, ${b.baseUrl}, ${b.authHeader ?? "Authorization"}, ${b.authScheme ?? "bearer"},
          ${JSON.stringify(b.extraHeaders ?? {})}, ${JSON.stringify(b.queryParams ?? {})}, ${b.chatPath ?? "/chat/completions"}, ${creds},
          ${b.defaultModel}, ${db.array(b.enabledModels ?? [])}, ${b.isDefault ?? false}, ${b.enabled ?? true})`;
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A profile with this name already exists");
      throw e;
    }
    return c.json(profileDto((await getProfile(id))!), 201);
  });
  reg.route({ method: "PATCH", path: "/llm-profiles/:id", roles: OWNER, tag: "Providers", summary: "Update a profile (apiKey null clears the key)", body: updateProfileSchema }, async (c) => {
    const id = parseId(c);
    const { apiKey, ...patch } = await parseBody(c, updateProfileSchema);
    if (patch.baseUrl) await checkUrl(patch.baseUrl);
    const setCreds = apiKey !== undefined;
    const creds = apiKey ? sealKey(id, apiKey) : null;
    let ok: boolean;
    try {
      const [res] = await db<{ saUpdateLlmProfile: boolean }[]>`
        SELECT sa_update_llm_profile(${c.get("admin").id}, ${id}, ${JSON.stringify(patch)}, ${setCreds}, ${creds})`;
      ok = !!res?.saUpdateLlmProfile;
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A profile with this name already exists");
      throw e;
    }
    if (!ok) throw Errors.notFound("Profile not found");
    return c.json(profileDto((await getProfile(id))!));
  });
  reg.route({ method: "DELETE", path: "/llm-profiles/:id", roles: OWNER, tag: "Providers", summary: "Delete a provider profile" }, async (c) => {
    const [res] = await db<{ saDeleteLlmProfile: boolean }[]>`SELECT sa_delete_llm_profile(${c.get("admin").id}, ${parseId(c)})`;
    if (!res?.saDeleteLlmProfile) throw Errors.notFound("Profile not found");
    return c.json({ ok: true as const });
  });
  const testBody = z.strictObject({ model: z.string().trim().min(1).max(120).optional() });
  reg.route({ method: "POST", path: "/llm-profiles/:id/test", roles: OWNER, tag: "Providers", summary: "Call the provider with a tiny prompt; returns latency/model/error, never the key", body: testBody }, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, testBody);
    const [row] = await db<ProfileRow[]>`SELECT * FROM sa_llm_profile_for_test(${id}::uuid)`;
    if (!row) throw Errors.notFound("Profile not found");
    let secret = "";
    try { if (row.credentialsEncrypted && cfg.encryptionKey) secret = decryptJson<{ apiKey?: string }>(cfg.encryptionKey, row.credentialsEncrypted, profileAad(row.id)).apiKey ?? ""; } catch { /* reported below */ }
    const scrub = (m: string) => {
      let out = secret ? m.split(secret).join("***") : m;
      out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***").replace(/\b(sk|key|api)[-_][A-Za-z0-9_-]{12,}/gi, "***");
      return out.slice(0, 400);
    };
    const started = performance.now();
    try {
      const provider = await buildProfileProvider(row, { encryptionKey: cfg.encryptionKey, dnsResolver, allowPrivate: selfhosted, fetch: fetchImpl, timeoutMs: 20_000, maxRetries: 0 });
      const res = await provider.chat({ model: b.model ?? row.defaultModel, messages: [{ role: "user", content: "Reply with the single word OK." }], maxTokens: 8, temperature: 0 });
      return c.json({ ok: true, latencyMs: Math.round(performance.now() - started), model: res.model ?? b.model ?? row.defaultModel, error: null });
    } catch (e) {
      return c.json({ ok: false, latencyMs: Math.round(performance.now() - started), model: b.model ?? row.defaultModel, error: scrub((e as Error).message) });
    }
  });
}
