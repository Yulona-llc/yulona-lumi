// Platform-admin: LLM provider profiles, model rates, credit packs, tenant credit grants.
// Every write goes through an `sa_*` SECURITY DEFINER function that also writes platform_audit_logs.
import { Hono } from "hono";
import { z } from "zod";
import { type Db } from "@yulona/db";
import { SsrfError, assertSafeUrl, buildProfileProvider, profileAad, type ProfileRow } from "@yulona/ai-runtime";
import { decryptJson, encryptJson } from "@yulona/crypto";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { requireAdmin } from "../billing/admin";
import { isUniqueViolation, parseId, parseQuery } from "../platform/util";
import { creditsDto, type CreditsRowRaw } from "./credits";

type AdminEnv = { Variables: AppEnv["Variables"] & { adminId: string } };

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
  hasCredentials: p.hasCredentials, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
});

export function adminCreditsRoutes({ cfg, db, fetchImpl, dnsResolver }: { cfg: Config; db: Db; fetchImpl?: typeof fetch; dnsResolver?: (h: string) => Promise<string[]> }) {
  const r = new Hono<AdminEnv>();
  const guard = requireAdmin(cfg, db);
  const selfhosted = cfg.deploymentMode === "selfhosted";

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

  // ---------------------------------------------------------------- provider profiles
  r.get("/admin/llm-profiles", guard, async (c) => {
    const rows = await db<ProfileListRow[]>`SELECT * FROM sa_list_llm_profiles()`;
    return c.json({ items: rows.map(profileDto) });
  });
  r.get("/admin/llm-profiles/:id", guard, async (c) => {
    const p = await getProfile(parseId(c));
    if (!p) throw Errors.notFound("Profile not found");
    return c.json(profileDto(p));
  });
  r.post("/admin/llm-profiles", guard, async (c) => {
    const b = await parseBody(c, createProfileSchema);
    await checkUrl(b.baseUrl);
    const id = crypto.randomUUID();
    const creds = b.apiKey ? sealKey(id, b.apiKey) : null;
    try {
      await db`
        SELECT sa_create_llm_profile(${c.get("adminId")}, ${id}, ${b.name}, ${b.baseUrl}, ${b.authHeader ?? "Authorization"}, ${b.authScheme ?? "bearer"},
          ${JSON.stringify(b.extraHeaders ?? {})}, ${JSON.stringify(b.queryParams ?? {})}, ${b.chatPath ?? "/chat/completions"}, ${creds},
          ${b.defaultModel}, ${db.array(b.enabledModels ?? [])}, ${b.isDefault ?? false}, ${b.enabled ?? true})`;
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A profile with this name already exists");
      throw e;
    }
    return c.json(profileDto((await getProfile(id))!), 201);
  });
  r.patch("/admin/llm-profiles/:id", guard, async (c) => {
    const id = parseId(c);
    const { apiKey, ...patch } = await parseBody(c, updateProfileSchema);
    if (patch.baseUrl) await checkUrl(patch.baseUrl);
    const setCreds = apiKey !== undefined;
    const creds = apiKey ? sealKey(id, apiKey) : null;
    let ok: boolean;
    try {
      const [res] = await db<{ saUpdateLlmProfile: boolean }[]>`
        SELECT sa_update_llm_profile(${c.get("adminId")}, ${id}, ${JSON.stringify(patch)}, ${setCreds}, ${creds})`;
      ok = !!res?.saUpdateLlmProfile;
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A profile with this name already exists");
      throw e;
    }
    if (!ok) throw Errors.notFound("Profile not found");
    return c.json(profileDto((await getProfile(id))!));
  });
  r.delete("/admin/llm-profiles/:id", guard, async (c) => {
    const [res] = await db<{ saDeleteLlmProfile: boolean }[]>`SELECT sa_delete_llm_profile(${c.get("adminId")}, ${parseId(c)})`;
    if (!res?.saDeleteLlmProfile) throw Errors.notFound("Profile not found");
    return c.json({ ok: true as const });
  });
  r.post("/admin/llm-profiles/:id/test", guard, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, z.strictObject({ model: z.string().trim().min(1).max(120).optional() }));
    const [row] = await db<ProfileRow[]>`SELECT * FROM llm_profile_resolve(${id}::uuid)`;
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

  // ---------------------------------------------------------------- model rates
  r.get("/admin/model-rates", guard, async (c) => {
    const rows = await db<{ model: string; inputMicroPer1k: string; outputMicroPer1k: string; enabled: boolean; updatedAt: Date }[]>`
      SELECT model, input_micro_per_1k, output_micro_per_1k, enabled, updated_at FROM llm_model_rates ORDER BY (model = '*') DESC, model`;
    return c.json({ items: rows.map((x) => ({ model: x.model, inputMicroPer1k: Number(x.inputMicroPer1k), outputMicroPer1k: Number(x.outputMicroPer1k), enabled: x.enabled, updatedAt: x.updatedAt.toISOString() })) });
  });
  r.put("/admin/model-rates", guard, async (c) => {
    const b = await parseBody(c, modelRateSchema);
    await db`SELECT sa_set_model_rate(${c.get("adminId")}, ${b.model}, ${b.inputMicroPer1k}, ${b.outputMicroPer1k}, ${b.enabled ?? true})`;
    return c.json({ model: b.model, inputMicroPer1k: b.inputMicroPer1k, outputMicroPer1k: b.outputMicroPer1k, enabled: b.enabled ?? true });
  });
  r.delete("/admin/model-rates", guard, async (c) => {
    const q = parseQuery(c, z.strictObject({ model: z.string().trim().min(1).max(120) }));
    if (q.model === "*") throw Errors.validation([{ path: "model", message: "The default rate cannot be deleted" }]);
    const [res] = await db<{ saDeleteModelRate: boolean }[]>`SELECT sa_delete_model_rate(${c.get("adminId")}, ${q.model})`;
    if (!res?.saDeleteModelRate) throw Errors.notFound("Rate not found");
    return c.json({ ok: true as const });
  });

  // ---------------------------------------------------------------- credit packs
  interface PackRow { id: string; name: string; credits: string; priceCents: number; currency: string; active: boolean; sortOrder: number; createdAt: Date }
  const packDto = (p: PackRow) => ({ id: p.id, name: p.name, credits: Number(p.credits), priceCents: p.priceCents, currency: p.currency, active: p.active, sortOrder: p.sortOrder, createdAt: p.createdAt.toISOString() });
  const loadPack = async (id: string) => (await db<PackRow[]>`SELECT * FROM credit_packs WHERE id = ${id}`)[0];
  r.get("/admin/credit-packs", guard, async (c) => {
    const rows = await db<PackRow[]>`SELECT * FROM credit_packs ORDER BY sort_order, price_cents, id`;
    return c.json({ items: rows.map(packDto) });
  });
  r.post("/admin/credit-packs", guard, async (c) => {
    const b = await parseBody(c, createPackSchema);
    const [res] = await db<{ saUpsertCreditPack: string }[]>`
      SELECT sa_upsert_credit_pack(${c.get("adminId")}, NULL, ${b.name}, ${b.credits}, ${b.priceCents}, ${b.active ?? true}, ${b.sortOrder ?? 0})`;
    return c.json(packDto((await loadPack(res!.saUpsertCreditPack))!), 201);
  });
  r.patch("/admin/credit-packs/:id", guard, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, updatePackSchema);
    const cur = await loadPack(id);
    if (!cur) throw Errors.notFound("Pack not found");
    await db`
      SELECT sa_upsert_credit_pack(${c.get("adminId")}, ${id}, ${b.name ?? cur.name}, ${b.credits ?? Number(cur.credits)}, ${b.priceCents ?? cur.priceCents},
        ${b.active ?? cur.active}, ${b.sortOrder ?? cur.sortOrder})`;
    return c.json(packDto((await loadPack(id))!));
  });
  r.delete("/admin/credit-packs/:id", guard, async (c) => {
    const [res] = await db<{ saDeleteCreditPack: string }[]>`SELECT sa_delete_credit_pack(${c.get("adminId")}, ${parseId(c)})`;
    if (res?.saDeleteCreditPack === "missing") throw Errors.notFound("Pack not found");
    return c.json({ ok: true as const, result: res!.saDeleteCreditPack });
  });

  // ---------------------------------------------------------------- tenant credits
  const tenantCredits = async (tenantId: string) => {
    const [row] = await db<(CreditsRowRaw & { planKey: string })[]>`
      SELECT plan_key, to_char(period, 'YYYY-MM-DD') AS period, allowance_micro, used_micro, topup_micro, topup_used_micro FROM sa_tenant_credits(${tenantId}::uuid)`;
    if (!row) throw Errors.notFound("Tenant not found");
    return { ...creditsDto(cfg.deploymentMode, row), planKey: row.planKey };
  };
  r.get("/admin/tenants/:id/credits", guard, async (c) => c.json(await tenantCredits(parseId(c))));
  r.post("/admin/tenants/:id/credits", guard, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, grantSchema);
    const micro = Math.round(b.credits * 1_000_000);
    const [res] = await db<{ saGrantCredits: boolean }[]>`SELECT sa_grant_credits(${c.get("adminId")}, ${id}, ${micro}, ${b.reason})`;
    if (!res?.saGrantCredits) throw Errors.notFound("Tenant not found");
    return c.json(await tenantCredits(id));
  });

  return r;
}
