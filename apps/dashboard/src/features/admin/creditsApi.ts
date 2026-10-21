import { areq } from "./api";
import type { CreditsInfo } from "../usage/api";

export interface LlmProfile {
  id: string; name: string; baseUrl: string; authHeader: string; authScheme: "bearer" | "raw" | "none";
  extraHeaders: Record<string, string>; queryParams: Record<string, string>; chatPath: string;
  defaultModel: string; enabledModels: string[]; isDefault: boolean; enabled: boolean; hasCredentials: boolean;
  createdAt: string; updatedAt: string;
}
export interface ProfileInput {
  name?: string; baseUrl?: string; defaultModel?: string; apiKey?: string | null; authHeader?: string; authScheme?: string;
  extraHeaders?: Record<string, string>; queryParams?: Record<string, string>; chatPath?: string; enabledModels?: string[];
  isDefault?: boolean; enabled?: boolean;
}
export interface TestResult { ok: boolean; latencyMs: number; model: string | null; error: string | null }
export interface ModelRate { model: string; inputMicroPer1k: number; outputMicroPer1k: number; enabled: boolean; updatedAt: string }
export interface AdminPack { id: string; name: string; credits: number; priceCents: number; active: boolean; sortOrder: number; createdAt: string }
export interface PackInput { name?: string; credits?: number; priceCents?: number; active?: boolean; sortOrder?: number }
export interface PlanRow { key: string; name: string; limits: Record<string, number | null> }
export type TenantCredits = CreditsInfo & { planKey?: string };

export const CREDITS_METRIC = "llm_credits_monthly";

export const creditsAdmin = {
  profiles: () => areq<{ items: LlmProfile[] }>("/admin/llm-profiles").then((r) => r.items),
  createProfile: (b: ProfileInput) => areq<LlmProfile>("/admin/llm-profiles", "POST", b),
  updateProfile: (id: string, b: ProfileInput) => areq<LlmProfile>(`/admin/llm-profiles/${id}`, "PATCH", b),
  deleteProfile: (id: string) => areq<{ ok: true }>(`/admin/llm-profiles/${id}`, "DELETE"),
  testProfile: (id: string, model?: string) => areq<TestResult>(`/admin/llm-profiles/${id}/test`, "POST", model ? { model } : {}),
  rates: () => areq<{ items: ModelRate[] }>("/admin/model-rates").then((r) => r.items),
  setRate: (b: { model: string; inputMicroPer1k: number; outputMicroPer1k: number; enabled?: boolean }) => areq<ModelRate>("/admin/model-rates", "PUT", b),
  deleteRate: (model: string) => areq<{ ok: true }>(`/admin/model-rates?model=${encodeURIComponent(model)}`, "DELETE"),
  plans: () => areq<{ items: PlanRow[] }>("/admin/plans").then((r) => r.items),
  setPlanCredits: (key: string, limit: number | null) => areq<unknown>(`/admin/plans/${encodeURIComponent(key)}/limits/${CREDITS_METRIC}`, "PUT", { limit }),
  packs: () => areq<{ items: AdminPack[] }>("/admin/credit-packs").then((r) => r.items),
  createPack: (b: PackInput) => areq<AdminPack>("/admin/credit-packs", "POST", b),
  updatePack: (id: string, b: PackInput) => areq<AdminPack>(`/admin/credit-packs/${id}`, "PATCH", b),
  deletePack: (id: string) => areq<{ ok: true }>(`/admin/credit-packs/${id}`, "DELETE"),
  tenantCredits: (id: string) => areq<TenantCredits>(`/admin/tenants/${id}/credits`),
  grant: (id: string, credits: number, reason: string) => areq<TenantCredits>(`/admin/tenants/${id}/credits`, "POST", { credits, reason }),
};

/** Admin query keys; `["admin", "credits", ...]` is a separate namespace from the tenant-side `["credits", ...]`. */
export const adminCreditKeys = {
  profiles: ["admin", "credits", "profiles"] as const,
  rates: ["admin", "credits", "rates"] as const,
  plans: ["admin", "credits", "plans"] as const,
  packs: ["admin", "credits", "packs"] as const,
  tenant: (id: string) => ["admin", "credits", "tenant", id] as const,
};
