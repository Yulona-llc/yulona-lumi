import { z } from "zod";
import { WEBHOOK_EVENTS } from "@yulona/integrations";

const ts = z.string();
/** Response DTO schemas for OpenAPI only (routes build the objects directly). */
export function createWebhookDeliverySchemas() {
  const webhook = z.object({
    id: z.uuid(), name: z.string(), url: z.string(), events: z.array(z.enum([...WEBHOOK_EVENTS, "*"])), enabled: z.boolean(),
    disabledReason: z.string().nullable(), consecutiveFailures: z.number().int(), lastSuccessAt: ts.nullable(), lastFailureAt: ts.nullable(),
    createdAt: ts, updatedAt: ts,
  });
  const delivery = z.object({
    id: z.uuid(), webhookId: z.uuid(), eventId: z.uuid(), eventType: z.string(),
    status: z.enum(["pending", "retrying", "succeeded", "failed", "cancelled"]), attempts: z.number().int(), maxAttempts: z.number().int(),
    nextAttemptAt: ts.nullable(), responseStatus: z.number().int().nullable(), lastError: z.string().nullable(),
    lastDurationMs: z.number().int().nullable(), redeliveryOf: z.uuid().nullable(), createdAt: ts, completedAt: ts.nullable(),
  });
  return {
    webhook,
    webhookWithSecret: webhook.extend({ secret: z.string().describe("whsec_... shown only now") }),
    delivery,
    deliveryDetail: delivery.extend({
      payload: z.unknown(),
      attemptLog: z.array(z.object({ attempt: z.number().int(), statusCode: z.number().int().nullable(), error: z.string().nullable(), durationMs: z.number().int().nullable(), responseSnippet: z.string().nullable(), at: ts })),
    }),
    gdprRequest: z.object({
      id: z.uuid(), kind: z.enum(["export", "erasure"]), contactId: z.uuid().nullable(), status: z.enum(["queued", "processing", "completed", "failed"]),
      requestedBy: z.uuid().nullable(), sizeBytes: z.number().int().nullable(), result: z.record(z.string(), z.unknown()), error: z.string().nullable(),
      downloadAvailable: z.boolean(), expiresAt: ts.nullable(), createdAt: ts, completedAt: ts.nullable(),
    }),
    retention: z.object({
      messagesDays: z.number().int().nullable(), auditLogsDays: z.number().int().nullable(), webhookLogsDays: z.number().int().nullable(),
      toolLogsDays: z.number().int().nullable(), updatedAt: ts.nullable(),
      defaults: z.object({ messagesDays: z.null(), auditLogsDays: z.null(), webhookLogsDays: z.number().int(), toolLogsDays: z.null() }),
    }),
    booking: z.object({
      id: z.uuid(), status: z.enum(["booked", "cancelled", "failed"]), title: z.string(), startAt: ts, endAt: ts, timezone: z.string().nullable(),
      contactId: z.uuid().nullable(), conversationId: z.uuid().nullable(), attendeeEmail: z.string().nullable(), notes: z.string().nullable(),
      provider: z.string().nullable(), eventUrl: z.string().nullable(), cancelledAt: ts.nullable(), createdAt: ts,
    }),
  };
}
