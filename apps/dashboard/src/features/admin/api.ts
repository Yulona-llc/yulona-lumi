import { ApiError } from "../../api/client";
import { apiBase } from "../../config";
import { downloadAuthed, qs } from "../integrations-ui/http";

/** Platform-admin realm: separate token, held in memory only, never shared with the tenant session. */
let adminToken: string | null = null;
let listeners = new Set<() => void>();
export const getAdminToken = () => adminToken;
export const subscribeAdmin = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const setTok = (t: string | null) => { adminToken = t; listeners.forEach((f) => f()); };

export async function areq<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method, credentials: "omit",
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection."); }
  if (!res.ok) {
    let e: { error?: { code?: string; message?: string } } = {};
    try { e = await res.json(); } catch { /* ignore */ }
    if (res.status === 401) setTok(null);
    throw new ApiError(res.status, e.error?.code ?? "http_error", e.error?.message ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface AdminUser { id: string; email: string; name?: string }
export interface TenantRow { id: string; name: string; status: string; plan: string; deletedAt: string | null; createdAt: string; userCount: number }
export interface TenantDetail {
  tenant: { id: string; name: string; status: string; plan?: string; plan_key?: string; createdAt?: string };
  billing?: { state?: string; plan?: unknown } | null;
  limits: Array<{ metric: string; limit: number | null; used: number; warning: boolean }>;
  counts: { users: number; agents: number; widgets: number; contacts: number; conversations: number; knowledgeSources: number };
  lastActivityAt: string | null;
}
export interface Analytics {
  tenants: { total: number; active: number; suspended: number; deleted: number; new30d: number };
  byPlan: Array<{ plan: string; count: number }>; mrrCents: number;
  conversations: { last30d: number; perDay: Array<{ day: string; count: number }> };
  funnel: Array<{ stage: string; conversations: number }>;
}
export interface Health { status: "ok" | "degraded" | "down"; db: { ok: boolean; latencyMs: number }; queue: { queued: number; running: number; dead: number; oldestQueuedAgeSec: number | null }; worker: { lastHeartbeatAt: string | null; ageSec: number | null; ok: boolean } }
export interface Flag { key: string; description?: string | null; defaultEnabled: boolean }
export interface ImpersonationResult { accessToken: string; expiresIn: number; sessionId: string; user: unknown; tenant: unknown }

export const adminApi = {
  login: async (email: string, password: string) => {
    const r = await areq<{ accessToken: string; admin: AdminUser }>("/admin/auth/login", "POST", { email, password });
    setTok(r.accessToken); return r.admin;
  },
  logout: () => setTok(null),
  me: () => areq<AdminUser | { admin: AdminUser }>("/admin/auth/me"),
  tenants: (f: { q?: string; limit?: number; offset?: number }) => areq<{ items: TenantRow[]; total: number }>(`/admin/tenants${qs(f)}`),
  detail: (id: string) => areq<TenantDetail>(`/admin/tenants/${id}/detail`),
  usage: (id: string, days = 30) => areq<{ series: Array<{ day: string; metric: string; value: number }> }>(`/admin/tenants/${id}/usage${qs({ days })}`),
  suspend: (id: string, on: boolean) => areq<unknown>(`/admin/tenants/${id}/${on ? "suspend" : "unsuspend"}`, "POST", {}),
  analytics: () => areq<Analytics>("/admin/analytics"),
  health: () => areq<Health>("/admin/health"),
  flags: () => areq<{ flags?: Flag[]; items?: Flag[] } | Flag[]>("/admin/feature-flags").then((r) => (Array.isArray(r) ? r : (r.flags ?? r.items ?? []))),
  setFlag: (key: string, b: { description?: string; defaultEnabled: boolean }) => areq<unknown>(`/admin/feature-flags/${encodeURIComponent(key)}`, "PUT", b),
  deleteFlag: (key: string) => areq<unknown>(`/admin/feature-flags/${encodeURIComponent(key)}`, "DELETE"),
  tenantFlags: (id: string) => areq<unknown>(`/admin/tenants/${id}/flags`),
  setTenantFlag: (id: string, key: string, enabled: boolean | null) => areq<unknown>(`/admin/tenants/${id}/flags/${encodeURIComponent(key)}`, "PUT", { enabled }),
  impersonate: (id: string, reason: string) => areq<ImpersonationResult>(`/admin/tenants/${id}/impersonate`, "POST", { reason }),
  endImpersonation: (sessionId: string) => areq<{ ok: true }>(`/admin/impersonation/${sessionId}/end`, "POST", {}),
  exportAudit: (format: "csv" | "json") => downloadAuthed(`/admin/audit-logs/export?format=${format}`, `platform-audit.${format}`, adminToken),
};
