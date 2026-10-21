import { z } from "zod";
import { errorEnvelopeSchema } from "@yulona/shared";
import { createPackSchema, createProfileSchema, grantSchema, modelRateSchema, updatePackSchema, updateProfileSchema } from "./admin";
import { usageAiQuery } from "./routes";

const j = (s: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const ok = (d: string, s?: z.ZodType) => ({ description: d, ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}) });
const jwt = [{ bearerAuth: [] }];
const adm = [{ platformAdminAuth: [] }];
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const std = { 400: err("Validation error"), 401: err("Unauthorized"), 404: err("Not found") };
const asQuery = (s: z.ZodType) => {
  const sch = j(s) as { properties?: Record<string, Record<string, unknown>> };
  return Object.entries(sch.properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: false, schema }));
};

const credits = z.object({
  mode: z.enum(["saas", "selfhosted"]), enabled: z.boolean(), unlimited: z.boolean(), period: z.string(), allowanceMicro: z.number().nullable(), usedMicro: z.number(),
  topupMicro: z.number(), topupUsedMicro: z.number(), remainingMicro: z.number().nullable(), percentUsed: z.number().nullable(),
  status: z.enum(["ok", "warning", "exhausted"]), warnings: z.array(z.enum(["warning_80", "exhausted"])),
});
const usageItem = z.object({ key: z.string(), label: z.string(), promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number(), requests: z.number(), creditsMicro: z.number() });
const profile = z.object({
  id: z.uuid(), name: z.string(), baseUrl: z.string(), authHeader: z.string(), authScheme: z.enum(["bearer", "raw", "none"]), extraHeaders: z.record(z.string(), z.string()),
  queryParams: z.record(z.string(), z.string()), chatPath: z.string(), defaultModel: z.string(), enabledModels: z.array(z.string()), isDefault: z.boolean(),
  enabled: z.boolean(), hasCredentials: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
const pack = z.object({ id: z.uuid(), name: z.string(), credits: z.number().int(), priceCents: z.number().int(), currency: z.string(), active: z.boolean(), sortOrder: z.number().int(), createdAt: z.string() });

/** Usage metering, credits and provider-config endpoints (docs/api/credits.md). */
export function usagePaths(): Record<string, unknown> {
  const U = "Usage", B = "Billing", A = "Admin";
  const t = (summary: string, extra: Record<string, unknown>) => ({ summary, tags: [U], security: jwt, ...extra });
  const a = (summary: string, extra: Record<string, unknown>) => ({ summary, tags: [A], security: adm, ...extra });
  const aStd = { 400: err("Validation error"), 401: err("Unauthorized"), 404: err("Not found") };
  return {
    "/api/v1/usage/credits": { get: t("Credits for the current period (any role)", { responses: { 200: ok("Credits", credits), 401: err("Unauthorized") } }) },
    "/api/v1/usage/ai": { get: t("AI usage grouped by day|agent|model|conversation (min role: admin)", {
      parameters: asQuery(usageAiQuery),
      responses: { 200: ok("Usage", z.object({ from: z.string(), to: z.string(), groupBy: z.string(), items: z.array(usageItem), totals: usageItem.omit({ key: true, label: true }) })), ...std, 403: err("Insufficient role") } }) },
    "/api/v1/usage/ai/export": { get: t("AI usage as CSV (min role: admin)", { parameters: asQuery(usageAiQuery), responses: { 200: { description: "text/csv" }, ...std, 403: err("Insufficient role") } }) },
    "/api/v1/billing/credit-packs": { get: { summary: "Purchasable credit packs (SaaS; min role: admin)", tags: [B], security: jwt, responses: { 200: ok("Packs", z.object({ items: z.array(pack.pick({ id: true, name: true, credits: true, priceCents: true, currency: true })) })), 401: err("Unauthorized"), 403: err("Insufficient role") } } },
    "/api/v1/billing/credits/checkout": { post: { summary: "Start a one-time credit pack checkout (SaaS; min role: admin)", tags: [B], security: jwt, requestBody: body(z.strictObject({ packId: z.uuid() })),
      responses: { 200: ok("Checkout URL", z.object({ url: z.string() })), ...std, 403: err("Insufficient role"), 503: err("Billing provider unavailable") } } },
    "/api/v1/admin/llm-profiles": {
      get: a("List LLM provider profiles (never returns keys)", { responses: { 200: ok("Profiles", z.object({ items: z.array(profile) })), 401: err("Unauthorized") } }),
      post: a("Create a provider profile (SSRF-checked URL, key encrypted)", { requestBody: body(createProfileSchema), responses: { 201: ok("Profile", profile), 409: err("Duplicate name"), 503: err("ENCRYPTION_KEY missing"), ...aStd } }),
    },
    "/api/v1/admin/llm-profiles/{id}": {
      get: a("Get a profile", { parameters: [id], responses: { 200: ok("Profile", profile), ...aStd } }),
      patch: a("Update a profile (apiKey null clears the key; isDefault true moves the default)", { parameters: [id], requestBody: body(updateProfileSchema), responses: { 200: ok("Profile", profile), 409: err("Duplicate name"), ...aStd } }),
      delete: a("Delete a profile", { parameters: [id], responses: { 200: ok("OK"), ...aStd } }),
    },
    "/api/v1/admin/llm-profiles/{id}/test": { post: a("Call the provider with a tiny prompt; returns latency/model/error, never the key", {
      parameters: [id], requestBody: body(z.strictObject({ model: z.string().optional() })),
      responses: { 200: ok("Result", z.object({ ok: z.boolean(), latencyMs: z.number(), model: z.string().nullable(), error: z.string().nullable() })), ...aStd } }) },
    "/api/v1/admin/model-rates": {
      get: a("Model rates (micro-credits per 1k tokens)", { responses: { 200: ok("Rates"), 401: err("Unauthorized") } }),
      put: a("Upsert a model rate", { requestBody: body(modelRateSchema), responses: { 200: ok("Rate"), ...aStd } }),
      delete: a("Delete a model rate (?model=; the * default cannot be deleted)", { parameters: [{ name: "model", in: "query", required: true, schema: { type: "string" } }], responses: { 200: ok("OK"), ...aStd } }),
    },
    "/api/v1/admin/credit-packs": {
      get: a("List credit packs (incl. inactive)", { responses: { 200: ok("Packs", z.object({ items: z.array(pack) })), 401: err("Unauthorized") } }),
      post: a("Create a credit pack", { requestBody: body(createPackSchema), responses: { 201: ok("Pack", pack), ...aStd } }),
    },
    "/api/v1/admin/credit-packs/{id}": {
      patch: a("Update a credit pack", { parameters: [id], requestBody: body(updatePackSchema), responses: { 200: ok("Pack", pack), ...aStd } }),
      delete: a("Delete (or deactivate when already purchased) a credit pack", { parameters: [id], responses: { 200: ok("OK"), ...aStd } }),
    },
    "/api/v1/admin/tenants/{id}/credits": {
      get: a("A tenant's credits for the current period", { parameters: [id], responses: { 200: ok("Credits", credits), ...aStd } }),
      post: a("Grant or adjust (negative) credits with an audited reason", { parameters: [id], requestBody: body(grantSchema), responses: { 200: ok("Credits", credits), ...aStd } }),
    },
  };
}
