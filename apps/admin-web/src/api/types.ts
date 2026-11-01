/** Types for docs/api/platform-admin.md. Money is integer cents; fields ending in Micro are micro-credits (1 credit = 1_000_000). */
export type Role = "owner" | "support" | "billing";
export type Restricted = null | "password_change" | "two_factor_enrolment";
export interface Me { id: string; email: string; name: string; role: Role; twoFactorEnabled: boolean; restricted: Restricted }
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

export type Bucket = "healthy" | "watch" | "at_risk";
export interface HealthReason { code: string; label: string; points: number }
export interface Health { score: number; bucket: Bucket; reasons: HealthReason[] }
export type CreditsState = "ok" | "low" | "exhausted" | "unlimited";

export interface AttentionItem { id: string; name: string; plan: string; status: string; health: Health; ownerEmail: string | null; errorCount7d: number; lastActiveAt: string | null }
export interface SeriesPoint { day: string; value: number }
export interface Overview {
  tenants: { total: number; active: number; suspended: number; deleted: number; new7d: number; new30d: number; newPrev30d: number };
  active7d: number; activePrev7d: number; mrrCents: number; creditsConsumed30d: number; creditsConsumedPrev30d: number;
  healthBuckets: Record<Bucket, number>;
  byPlan: Array<{ plan: string; count: number }>;
  series: { signups: SeriesPoint[]; conversations: SeriesPoint[]; credits: SeriesPoint[] };
  attention: AttentionItem[];
}
export interface PlatformHealth {
  status: "ok" | "degraded" | "down";
  db: { ok: boolean; latencyMs: number };
  queue: { queued: number; running: number; dead: number; oldestQueuedAgeSec: number | null };
  worker: { lastHeartbeatAt: string | null; ageSec: number | null; ok: boolean };
}
export interface SearchResult {
  tenants: Array<{ id: string; name: string; status: string; plan: string; matchedOn: "name" | "id" | "member_email" }>;
  users: Array<{ id: string; tenantId: string; tenantName: string; email: string; name: string; role: string; status: string }>;
}

export interface TenantListItem {
  id: string; name: string; status: string; plan: string; createdAt: string; deletedAt: string | null; userCount: number; ownerEmail: string | null;
  lastActiveAt: string | null; errorCount7d: number; credits: { state: CreditsState; remainingMicro: number | null }; health: Health; tags: string[];
}
export interface TenantFilters {
  q?: string; status?: string; plan?: string; health?: string; createdFrom?: string; createdTo?: string; inactiveDays?: string;
  hasErrors?: string; credits?: string; tag?: string; sort?: string; order?: string; limit?: number; offset?: number;
}
export interface CreditsInfo {
  mode: string; enabled: boolean; unlimited: boolean; period: string; allowanceMicro: number; usedMicro: number; topupMicro: number; topupUsedMicro: number;
  remainingMicro: number; percentUsed: number; status: "ok" | "warning" | "exhausted"; warnings: string[]; planKey: string;
}
export interface TenantDetail {
  tenant: { id: string; name: string; status: string; plan: string; createdAt: string; deletedAt: string | null };
  owner: { email: string; name: string } | null;
  health: Health;
  counts: { users: number; agents: number; widgets: number; channels: number; contacts: number; conversations: number; knowledgeSources: number };
  lastActivityAt: string | null; errorCount7d: number;
  limits: Array<{ metric: string; limit: number | null; used: number; warning: boolean }>;
  billing: { status: string; planKey: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null } | null;
  credits: CreditsInfo; tags: string[]; notesCount: number;
}
export interface TenantUser { id: string; email: string; name: string; role: string; status: string; lastLoginAt: string | null; createdAt: string; locked: boolean }
export interface Invitation { id: string; email: string; role: string; createdAt: string; expiresAt: string; status: "pending" | "expired" | "accepted" | "revoked" }
export interface TimelineItem { at: string; source: string; action: string; actor: string | null; resourceType: string | null; resourceId: string | null; detail: unknown }
export type ErrorKind = "job_failed" | "webhook_delivery_failed" | "channel_error" | "channel_delivery_failed" | "knowledge_ingest_failed" | "notification_email_failed" | "crm_sync_failed" | "handoff_system_failure" | "abuse_handoff" | "tool_failed";
export interface IssueItem { kind: ErrorKind; at: string; refId: string | null; title: string; detail: string | null; hint: string | null }
export interface Issues { items: IssueItem[]; total: number; counts: Partial<Record<ErrorKind, number>> }
export interface Assets {
  agents: Array<{ id: string; name: string; status: string; publishedVersion: number | null; updatedAt: string }>;
  widgets: Array<{ id: string; name: string; enabled: boolean; agentId: string | null; domains: string[] }>;
  channels: Array<{ id: string; channel: string; name: string; status: string; agentId: string | null; lastHealthAt: string | null; lastHealthOk: boolean | null; lastHealthError: string | null }>;
  knowledge: Array<{ id: string; name: string; type: string; status: string; error: string | null; chunkCount: number; lastIngestedAt: string | null }>;
  connections: Array<{ id: string; name: string; kind: string; authType: string; host: string | null }>;
  webhooks: Array<{ id: string; name: string; enabled: boolean; host: string | null; disabledReason: string | null; consecutiveFailures: number; lastSuccessAt: string | null; lastFailureAt: string | null }>;
  calendar: Array<{ provider: string; status: string; lastError: string | null }>;
  crm: Array<{ provider: string; status: string; lastError: string | null; lastSyncAt: string | null }>;
}
export interface BillingInfo {
  plan: string;
  subscription: { status: string; planKey: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null } | null;
  events: Array<{ type: string; receivedAt: string }>;
  topups: Array<{ at: string; credits: number; amountCents: number; pack: string | null }>;
}
export interface AiUsage {
  series: Array<{ day: string; model: string; source: string; requests: number; promptTokens: number; completionTokens: number; creditsMicro: number }>;
  totals: { requests: number; promptTokens: number; completionTokens: number; creditsMicro: number };
}
export interface FlagRow { key: string; defaultEnabled: boolean; override: boolean | null; effective: boolean }
export interface Note { id: string; body: string; adminId: string; adminEmail: string; createdAt: string }
export interface ImpersonationRecord { id: string; adminId: string; adminEmail: string; tenantId: string; tenantName: string; userId: string; reason: string; readOnly: boolean; startedAt: string; expiresAt: string; endedAt: string | null; exchangedAt: string | null }
export interface ImpersonateResult { sessionId: string; code: string; codeExpiresIn: number; customerUrl: string; readOnly: boolean; user: { id: string; email: string; name: string; role: string }; tenant: { id: string; name: string } }

export interface DeadJob { id: string; tenantId: string | null; tenantName: string | null; name: string; attempts: number; maxAttempts: number; lastError: string | null; createdAt: string; updatedAt: string }
export interface FailedWebhook { id: string; tenantId: string; tenantName: string; webhookId: string; webhookName: string; eventType: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string; completedAt: string | null }
export interface AuditRow { id: string; adminId: string | null; adminEmail: string | null; action: string; tenantId: string | null; tenantName: string | null; metadata: unknown; createdAt: string }
export interface AdminRow { id: string; email: string; name: string; role: Role; status: string; twoFactorEnabled: boolean; lastLoginAt: string | null; createdAt: string }

export interface LlmProfile {
  id: string; name: string; baseUrl: string; authHeader: string; authScheme: "bearer" | "raw" | "none";
  extraHeaders: Record<string, string>; queryParams: Record<string, string>; chatPath: string;
  defaultModel: string; enabledModels: string[]; isDefault: boolean; enabled: boolean; hasCredentials: boolean; createdAt: string; updatedAt: string;
}
export interface ProfileInput {
  name?: string; baseUrl?: string; defaultModel?: string; apiKey?: string | null; authHeader?: string; authScheme?: string;
  extraHeaders?: Record<string, string>; queryParams?: Record<string, string>; chatPath?: string; enabledModels?: string[]; isDefault?: boolean; enabled?: boolean;
}
export interface TestResult { ok: boolean; latencyMs: number; model: string | null; error: string | null }
export interface ModelRate { model: string; inputMicroPer1k: number; outputMicroPer1k: number; enabled: boolean; updatedAt: string }
export interface AdminPack { id: string; name: string; credits: number; priceCents: number; currency: string; active: boolean; sortOrder: number; createdAt: string }
export interface PackInput { name?: string; credits?: number; priceCents?: number; active?: boolean; sortOrder?: number }
export interface PlanRow { key: string; name: string; limits: Record<string, number | null> }
export interface FeatureFlag { key: string; description: string; defaultEnabled: boolean }
