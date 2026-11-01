import { z } from "zod";
import { errorEnvelopeSchema } from "@yulona/shared";
import { usageAiQuery } from "./routes";

const j = (s: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const ok = (d: string, s?: z.ZodType) => ({ description: d, ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}) });
const jwt = [{ bearerAuth: [] }];
const std = { 400: err("Validation error"), 401: err("Unauthorized"), 404: err("Not found") };
const asQuery = (s: z.ZodType) => {
  const sch = j(s) as { properties?: Record<string, Record<string, unknown>> };
  return Object.entries(sch.properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: false, schema }));
};

const credits = z.object({
  mode: z.enum(["saas", "selfhosted"]), enabled: z.boolean(), unlimited: z.boolean(), period: z.string(), allowanceMicro: z.number().nullable(), usedMicro: z.number(),
  topupMicro: z.number(), topupUsedMicro: z.number(), remainingMicro: z.number().nullable(), percentUsed: z.number().nullable(),
  status: z.enum(["ok", "warning", "exhausted"]), warnings: z.array(z.enum(["warning_80", "exhausted"])),
  creditsPerMessage: z.number().nullable(), estimatedMessages: z.number().int().nullable(), estimateBasis: z.enum(["usage", "typical"]).nullable(),
});
const usageItem = z.object({ key: z.string(), label: z.string(), promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number(), requests: z.number(), creditsMicro: z.number() });
const pack = z.object({ id: z.uuid(), name: z.string(), credits: z.number().int(), priceCents: z.number().int(), currency: z.string(), active: z.boolean(), sortOrder: z.number().int(), createdAt: z.string() });

/** Usage metering, credits and provider-config endpoints (docs/api/credits.md). */
export function usagePaths(): Record<string, unknown> {
  const U = "Usage", B = "Billing";
  const t = (summary: string, extra: Record<string, unknown>) => ({ summary, tags: [U], security: jwt, ...extra });
  return {
    "/api/v1/usage/credits": { get: t("Credits for the current period (any role)", { responses: { 200: ok("Credits", credits), 401: err("Unauthorized") } }) },
    "/api/v1/usage/ai": { get: t("AI usage grouped by day|agent|model|conversation (min role: admin)", {
      parameters: asQuery(usageAiQuery),
      responses: { 200: ok("Usage", z.object({ from: z.string(), to: z.string(), groupBy: z.string(), items: z.array(usageItem), totals: usageItem.omit({ key: true, label: true }) })), ...std, 403: err("Insufficient role") } }) },
    "/api/v1/usage/ai/export": { get: t("AI usage as CSV (min role: admin)", { parameters: asQuery(usageAiQuery), responses: { 200: { description: "text/csv" }, ...std, 403: err("Insufficient role") } }) },
    "/api/v1/billing/credit-packs": { get: { summary: "Purchasable credit packs (SaaS; min role: admin)", tags: [B], security: jwt, responses: { 200: ok("Packs", z.object({ items: z.array(pack.pick({ id: true, name: true, credits: true, priceCents: true, currency: true })) })), 401: err("Unauthorized"), 403: err("Insufficient role") } } },
    "/api/v1/billing/credits/checkout": { post: { summary: "Start a one-time credit pack checkout (SaaS; min role: admin)", tags: [B], security: jwt, requestBody: body(z.strictObject({ packId: z.uuid() })),
      responses: { 200: ok("Checkout URL", z.object({ url: z.string() })), ...std, 403: err("Insufficient role"), 503: err("Billing provider unavailable") } } },
  };
}
