import { download, request } from "./client";
import type * as T from "./types";

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const post = <R = void>(path: string, body?: unknown) => request<R>(path, { method: "POST", body: body ?? {} });
const put = <R = void>(path: string, body?: unknown) => request<R>(path, { method: "PUT", body });
const patch = <R = void>(path: string, body?: unknown) => request<R>(path, { method: "PATCH", body });
const del = <R = void>(path: string) => request<R>(path, { method: "DELETE" });

export type LoginResult = { twoFactorRequired: true; challengeToken: string; expiresIn: number } | { twoFactorRequired?: undefined; accessToken: string; expiresIn: number; admin: T.Me };

export const adminApi = {
  // auth
  login: (email: string, password: string) => request<LoginResult>("/auth/login", { method: "POST", body: { email, password }, auth: false }),
  login2fa: (challengeToken: string, code: { code: string } | { recoveryCode: string }) =>
    request<Exclude<LoginResult, { twoFactorRequired: true }>>("/auth/login/2fa", { method: "POST", body: { challengeToken, ...code }, auth: false }),
  logout: () => request("/auth/logout", { method: "POST", cookie: true, auth: false, retry: false }),
  me: () => request<T.Me>("/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) => post("/auth/password", { currentPassword, newPassword }),
  twoFaSetup: (password: string) => post<{ secret: string; otpauthUrl: string }>("/auth/2fa/setup", { password }),
  twoFaConfirm: (code: string) => post<{ recoveryCodes: string[] }>("/auth/2fa/confirm", { code }),
  twoFaDisable: (password: string, code: { code: string } | { recoveryCode: string }) => post("/auth/2fa/disable", { password, ...code }),

  // overview
  overview: () => request<T.Overview>("/overview"),
  health: () => request<T.PlatformHealth>("/health"),
  search: (q: string) => request<T.SearchResult>(`/search${qs({ q, limit: 8 })}`),
  attention: (limit = 50, offset = 0) => request<{ items: T.AttentionItem[]; total: number }>(`/attention${qs({ limit, offset })}`),

  // customers
  tenants: (f: T.TenantFilters) => request<T.Page<T.TenantListItem>>(`/tenants${qs({ ...f })}`),
  exportTenants: (f: T.TenantFilters) => download(`/tenants/export${qs({ ...f, limit: undefined, offset: undefined })}`, "customers.csv"),
  tenant: (id: string) => request<T.TenantDetail>(`/tenants/${id}`),
  renameTenant: (id: string, name: string) => patch(`/tenants/${id}`, { name }),
  setPlan: (id: string, plan: string) => put(`/tenants/${id}/plan`, { plan }),
  tenantAction: (id: string, a: "suspend" | "unsuspend" | "restore") => post(`/tenants/${id}/${a}`),
  deleteTenant: (id: string) => del(`/tenants/${id}`),
  tenantUsers: (id: string) => request<{ items: T.TenantUser[]; invitations: T.Invitation[] }>(`/tenants/${id}/users`),
  resendInvite: (id: string, inv: string) => post<{ ok: true; emailSent: boolean }>(`/tenants/${id}/invitations/${inv}/resend`),
  timeline: (id: string, source: string, limit: number, offset: number) => request<{ items: T.TimelineItem[]; total: number }>(`/tenants/${id}/timeline${qs({ source, limit, offset })}`),
  issues: (id: string, kind: string, days: number, limit = 50, offset = 0) => request<T.Issues>(`/tenants/${id}/errors${qs({ kind, days, limit, offset })}`),
  exportIssues: (id: string, kind: string, days: number) => download(`/tenants/${id}/errors/export${qs({ kind, days })}`, "errors.csv"),
  assets: (id: string) => request<T.Assets>(`/tenants/${id}/assets`),
  billing: (id: string) => request<T.BillingInfo>(`/tenants/${id}/billing`),
  aiUsage: (id: string, days: number) => request<T.AiUsage>(`/tenants/${id}/ai-usage${qs({ days })}`),
  credits: (id: string) => request<T.CreditsInfo>(`/tenants/${id}/credits`),
  grant: (id: string, credits: number, reason: string) => post<T.CreditsInfo>(`/tenants/${id}/credits`, { credits, reason }),
  tenantFlags: (id: string) => request<{ items: T.FlagRow[] }>(`/tenants/${id}/flags`),
  setTenantFlag: (id: string, key: string, enabled: boolean | null) => put(`/tenants/${id}/flags/${encodeURIComponent(key)}`, { enabled }),
  notes: (id: string) => request<{ items: T.Note[] }>(`/tenants/${id}/notes`),
  addNote: (id: string, body: string) => post<T.Note>(`/tenants/${id}/notes`, { body }),
  deleteNote: (id: string, noteId: string) => del(`/tenants/${id}/notes/${noteId}`),
  setTags: (id: string, tags: string[]) => put(`/tenants/${id}/tags`, { tags }),
  allTags: () => request<{ items: Array<{ tag: string; count: number }> }>("/tags"),
  bulkTags: (tenantIds: string[], add: string[], remove: string[]) => post<{ updated: number }>("/tenants/tags/bulk", { tenantIds, ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) }),
  impersonations: (tenantId: string, limit = 20, offset = 0) => request<{ items: T.ImpersonationRecord[]; total: number }>(`/impersonations${qs({ tenantId, limit, offset })}`),
  impersonate: (id: string, b: { reason: string; readOnly: boolean; userId?: string }) => post<T.ImpersonateResult>(`/tenants/${id}/impersonate`, b),
  endImpersonation: (sessionId: string) => post(`/impersonation/${sessionId}/end`),

  // operations
  deadJobs: (limit = 50, offset = 0) => request<{ items: T.DeadJob[]; total: number }>(`/ops/dead-jobs${qs({ limit, offset })}`),
  retryJob: (id: string) => post(`/ops/dead-jobs/${id}/retry`),
  discardJob: (id: string) => post(`/ops/dead-jobs/${id}/discard`),
  failedWebhooks: (limit = 50, offset = 0) => request<{ items: T.FailedWebhook[]; total: number }>(`/ops/failed-webhooks${qs({ limit, offset })}`),

  // audit
  audit: (f: Record<string, string | number | undefined>) => request<{ items: T.AuditRow[]; total: number }>(`/audit-logs${qs(f)}`),
  exportAudit: (f: Record<string, string | number | undefined>, format: "csv" | "json") => download(`/audit-logs/export${qs({ ...f, limit: undefined, offset: undefined, format })}`, `audit.${format}`),

  // admins
  admins: () => request<{ items: T.AdminRow[] }>("/admins"),
  inviteAdmin: (b: { email: string; name: string; role: T.Role }) => post<{ id: string; email: string; role: T.Role; temporaryPassword: string }>("/admins", b),
  updateAdmin: (id: string, b: { name?: string; role?: T.Role }) => patch(`/admins/${id}`, b),
  adminAction: (id: string, a: "deactivate" | "activate" | "reset-2fa") => post(`/admins/${id}/${a}`),
  resetAdminPassword: (id: string) => post<{ temporaryPassword: string }>(`/admins/${id}/reset-password`),

  // catalogue
  plans: () => request<{ items: T.PlanRow[] }>("/plans").then((r) => r.items),
  setPlanLimit: (key: string, metric: string, limit: number | null) => put(`/plans/${encodeURIComponent(key)}/limits/${metric}`, { limit }),
  flags: () => request<{ items: T.FeatureFlag[] }>("/feature-flags").then((r) => r.items),
  upsertFlag: (key: string, b: { description?: string; defaultEnabled: boolean }) => put(`/feature-flags/${encodeURIComponent(key)}`, b),
  deleteFlag: (key: string) => del(`/feature-flags/${encodeURIComponent(key)}`),
  rates: () => request<{ items: T.ModelRate[] }>("/model-rates").then((r) => r.items),
  setRate: (b: { model: string; inputMicroPer1k: number; outputMicroPer1k: number; enabled?: boolean }) => put<T.ModelRate>("/model-rates", b),
  deleteRate: (model: string) => del(`/model-rates${qs({ model })}`),
  packs: () => request<{ items: T.AdminPack[] }>("/credit-packs").then((r) => r.items),
  createPack: (b: T.PackInput) => post<T.AdminPack>("/credit-packs", b),
  updatePack: (id: string, b: T.PackInput) => patch<T.AdminPack>(`/credit-packs/${id}`, b),
  deletePack: (id: string) => del(`/credit-packs/${id}`),
  profiles: () => request<{ items: T.LlmProfile[] }>("/llm-profiles").then((r) => r.items),
  createProfile: (b: T.ProfileInput) => post<T.LlmProfile>("/llm-profiles", b),
  updateProfile: (id: string, b: T.ProfileInput) => patch<T.LlmProfile>(`/llm-profiles/${id}`, b),
  deleteProfile: (id: string) => del(`/llm-profiles/${id}`),
  testProfile: (id: string, model?: string) => post<T.TestResult>(`/llm-profiles/${id}/test`, model ? { model } : {}),
};
