import { req, send, qs } from "./http";

export interface Webhook { id: string; name: string; url: string; events: string[]; enabled: boolean; disabledReason: string | null; consecutiveFailures: number; lastSuccessAt: string | null; lastFailureAt: string | null; createdAt: string; updatedAt: string }
export interface Delivery { id: string; webhookId: string; eventId: string; eventType: string; status: "pending" | "retrying" | "succeeded" | "failed" | "cancelled"; attempts: number; maxAttempts: number; nextAttemptAt: string | null; responseStatus: number | null; lastError: string | null; lastDurationMs: number | null; redeliveryOf: string | null; createdAt: string; completedAt: string | null }
export interface DeliveryDetail extends Delivery { payload: unknown; attemptLog: Array<{ attempt: number; statusCode: number | null; error: string | null; durationMs: number | null; responseSnippet: string | null; at: string }> }
export interface Retention { messagesDays: number | null; auditLogsDays: number | null; webhookLogsDays: number | null; toolLogsDays: number | null; updatedAt?: string | null; defaults?: unknown }
export interface GdprRequest { id: string; kind: "export" | "erasure"; contactId: string | null; status: "queued" | "processing" | "completed" | "failed"; sizeBytes: number | null; error: string | null; downloadAvailable: boolean; expiresAt: string | null; createdAt: string; completedAt: string | null }

export const intApi = {
  events: () => req<{ events: string[] }>("/webhooks/events").then((r) => r.events),
  hooks: () => req<{ items: Webhook[] }>("/webhooks").then((r) => r.items),
  createHook: (b: { name: string; url: string; events: string[]; enabled?: boolean }) => req<Webhook & { secret: string }>("/webhooks", send("POST", b)),
  updateHook: (id: string, b: Partial<{ name: string; url: string; events: string[]; enabled: boolean }>) => req<Webhook>(`/webhooks/${id}`, send("PATCH", b)),
  deleteHook: (id: string) => req<unknown>(`/webhooks/${id}`, send("DELETE")),
  rotate: (id: string) => req<{ id: string; secret: string }>(`/webhooks/${id}/rotate-secret`, send("POST", {})),
  test: (id: string) => req<{ deliveryId: string }>(`/webhooks/${id}/test`, send("POST", {})),
  deliveries: (id: string, f: { status?: string; cursor?: string | null }) => req<{ items: Delivery[]; nextCursor: string | null }>(`/webhooks/${id}/deliveries${qs({ ...f, limit: 25 })}`),
  delivery: (id: string) => req<DeliveryDetail>(`/webhook-deliveries/${id}`),
  redeliver: (id: string) => req<{ deliveryId: string }>(`/webhook-deliveries/${id}/redeliver`, send("POST", {})),
  retention: () => req<Retention>("/retention"),
  setRetention: (b: Retention) => req<Retention>("/retention", send("PUT", { messagesDays: b.messagesDays, auditLogsDays: b.auditLogsDays, webhookLogsDays: b.webhookLogsDays, toolLogsDays: b.toolLogsDays })),
  gdpr: () => req<{ items: GdprRequest[] }>("/gdpr/requests?limit=50").then((r) => r.items),
  gdprExport: (contactId?: string) => req<GdprRequest>("/gdpr/exports", send("POST", contactId ? { contactId } : {})),
  gdprErase: (contactId: string) => req<GdprRequest>("/gdpr/erasures", send("POST", { contactId, confirm: true })),
  gdprDownload: (id: string) => req<{ url?: string; expiresAt?: string }>(`/gdpr/requests/${id}/download`),
};
