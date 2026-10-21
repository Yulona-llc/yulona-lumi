import { z } from "zod";
import { request as rawRequest, getAccessToken, ApiError, type Opts } from "../../api/client";
import { apiBase } from "../../config";
import type { AgentConfig, ConversionStage, WidgetDto } from "@yulona/shared";

export type Role = "owner" | "admin" | "agent" | "viewer";
export interface Agent {
  id: string; name: string; description: string | null; status: "draft" | "published" | "archived";
  config: AgentConfig; publishedVersion: number | null; createdAt: string; updatedAt: string;
}
export interface AgentVersion { version: number; note: string | null; createdBy: string | null; createdAt: string }
export interface KnowledgeSource {
  id: string; agentId: string | null; type: "file" | "url" | "text"; name: string; skill?: string; description?: string | null;
  status: "pending" | "processing" | "ready" | "failed"; error: string | null; sourceUrl: string | null;
  fileName: string | null; sizeBytes: number; chunkCount: number; attempts: number; maxPages?: number;
  lastIngestedAt: string | null; createdAt: string; updatedAt: string;
}
export interface Chunk { id: string; chunkIndex: number; title?: string; content: string; tokenCount: number }
export interface SandboxResult {
  answer: string; stageBefore: ConversionStage; stageAfter: ConversionStage; guardTriggered: boolean;
  handoff: null | { type: string; reason: string; summary?: string; customerMessage?: string; leadCard?: Record<string, unknown> };
  toolRuns: Array<{ name: string; input?: unknown; output?: unknown; success: boolean; error?: string; latencyMs: number }>;
  lead: Record<string, unknown>;
  retrieved: Array<{ id: string; sourceId: string; sourceName: string; score: number; content: string; usedForAnswer: boolean }>;
  usage?: { promptTokens: number; completionTokens: number };
}
export interface UserRow { id: string; email: string; name: string; role: Role; status: "active" | "disabled"; lastLoginAt: string | null; createdAt: string }
export interface Invitation { id: string; email: string; role: Role; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: string; createdAt: string; invitedBy: string | null }
export interface ApiKeyRow { id: string; name: string; prefix: string; scopes: string[]; rateLimitPerMinute: number; expiresAt: string | null; createdAt?: string; lastUsedAt?: string | null; revokedAt?: string | null; key?: string }
export interface AuditRow { id: string; actorUserId: string | null; action: string; resourceType: string | null; resourceId: string | null; metadata: unknown; ip: string | null; requestId: string | null; createdAt: string }
export interface TenantInfo { id: string; name: string; status: string; plan: { key: string; name: string }; limits: Array<{ metric: string; limit: number | null; used: number; warning: boolean }> }
export interface Embed { snippet: string; widgetKey: string; apiUrl: string; scriptUrl: string }

/** Typed-by-assertion wrapper: the client only parses JSON when given a schema. */
const request = <T,>(path: string, o: Opts<T> = {}) => rawRequest<T>(path, { ...o, schema: z.any() as z.ZodType<T> });
const A = { auth: true } as const;
const j = (method: string, body?: unknown) => ({ ...A, method, body });
const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const ag = {
  tenant: () => request<TenantInfo>("/tenant", A),
  renameTenant: (name: string) => request<{ id: string; name: string }>("/tenant", j("PATCH", { name })),

  agents: () => request<unknown>("/agents", A).then((r) => (Array.isArray(r) ? r : (r as { items: Agent[] }).items) as Agent[]),
  agent: (id: string) => request<Agent>(`/agents/${id}`, A),
  createAgent: (b: { name: string; description?: string }) => request<Agent>("/agents", j("POST", b)),
  updateAgent: (id: string, b: { name?: string; description?: string; config?: Partial<AgentConfig> }) => request<Agent>(`/agents/${id}`, j("PATCH", b)),
  publish: (id: string, note?: string) => request<Agent>(`/agents/${id}/publish`, j("POST", note ? { note } : {})),
  rollback: (id: string, version: number, note?: string) => request<Agent>(`/agents/${id}/rollback`, j("POST", { version, ...(note ? { note } : {}) })),
  versions: (id: string) => request<{ items: AgentVersion[] }>(`/agents/${id}/versions`, A).then((r) => r.items),
  archive: (id: string) => request<unknown>(`/agents/${id}`, j("DELETE")),
  unarchive: (id: string) => request<unknown>(`/agents/${id}/unarchive`, j("POST", {})),

  sources: (agentId?: string) => request<{ items: KnowledgeSource[] }>(`/knowledge/sources${qs({ agentId, limit: 100 })}`, A).then((r) => r.items),
  chunks: (id: string, offset = 0) => request<{ items: Chunk[] }>(`/knowledge/sources/${id}/chunks${qs({ limit: 20, offset })}`, A).then((r) => r.items),
  addText: (b: { name: string; text: string; agentId?: string }) => request<KnowledgeSource>("/knowledge/sources/text", j("POST", b)),
  addUrl: (b: { url: string; name?: string; agentId?: string; maxPages?: number }) => request<KnowledgeSource>("/knowledge/sources/url", j("POST", b)),
  updateSource: (id: string, b: { name?: string; description?: string | null }) => request<KnowledgeSource>(`/knowledge/sources/${id}`, j("PATCH", b)),
  reingest: (id: string) => request<unknown>(`/knowledge/sources/${id}/reingest`, j("POST", {})),
  deleteSource: (id: string) => request<unknown>(`/knowledge/sources/${id}`, j("DELETE")),
  sandbox: (b: { agentId: string; message: string; stage?: ConversionStage; history?: Array<{ role: "user" | "assistant"; content: string }>; lead?: Record<string, string> }) =>
    request<SandboxResult>("/knowledge/sandbox", j("POST", b)),

  widgets: () => request<unknown>("/widgets", A).then((r) => (Array.isArray(r) ? r : (r as { items: WidgetDto[] }).items) as WidgetDto[]),
  createWidget: (b: Record<string, unknown>) => request<WidgetDto>("/widgets", j("POST", b)),
  updateWidget: (id: string, b: Record<string, unknown>) => request<WidgetDto>(`/widgets/${id}`, j("PATCH", b)),
  rotateKey: (id: string) => request<WidgetDto>(`/widgets/${id}/rotate-key`, j("POST", {})),
  embed: (id: string) => request<Embed>(`/widgets/${id}/embed`, A),

  users: () => request<{ items: UserRow[] }>("/users", A).then((r) => r.items),
  updateUser: (id: string, b: { name?: string; role?: Role; status?: "active" | "disabled" }) => request<UserRow>(`/users/${id}`, j("PATCH", b)),
  invitations: () => request<{ items: Invitation[] }>("/invitations", A).then((r) => r.items),
  invite: (b: { email: string; role: Role }) => request<{ id: string; email: string; role: Role; expiresAt: string; emailSent: boolean; inviteUrl?: string }>("/invitations", j("POST", b)),
  revokeInvite: (id: string) => request<unknown>(`/invitations/${id}`, j("DELETE")),

  apiKeys: () => request<unknown>("/api-keys", A).then((r) => (Array.isArray(r) ? r : (r as { items: ApiKeyRow[] }).items) as ApiKeyRow[]),
  createApiKey: (b: { name: string; scopes?: string[]; rateLimitPerMinute?: number; expiresAt?: string }) => request<ApiKeyRow>("/api-keys", j("POST", b)),
  revokeApiKey: (id: string) => request<unknown>(`/api-keys/${id}`, j("DELETE")),

  audit: (f: { action?: string; resourceType?: string; actorUserId?: string; from?: string; to?: string; cursor?: string | null }) =>
    request<{ items: AuditRow[]; nextCursor: string | null }>(`/audit-logs${qs({ ...f, limit: 50 })}`, A),
};

/** Multipart upload with progress (fetch cannot report upload progress). Uses the in-memory access token. */
export function uploadFile(file: File, opts: { name?: string; agentId?: string }, onProgress: (pct: number) => void): Promise<KnowledgeSource> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}/knowledge/sources/file`);
    xhr.withCredentials = true;
    const t = getAccessToken();
    if (t) xhr.setRequestHeader("Authorization", `Bearer ${t}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Cannot reach the server. Check your connection."));
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as KnowledgeSource);
      else reject(new ApiError(xhr.status, body?.error?.code ?? "http_error", body?.error?.message ?? `Upload failed (${xhr.status})`, body?.error?.requestId));
    };
    const fd = new FormData();
    fd.append("file", file);
    if (opts.name) fd.append("name", opts.name);
    if (opts.agentId) fd.append("agentId", opts.agentId);
    xhr.send(fd);
  });
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong");
