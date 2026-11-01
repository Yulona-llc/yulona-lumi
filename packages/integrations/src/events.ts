import type { Tx } from "@yulona/db";

/** Event types a webhook can subscribe to (`*` = all). Emitted by DB triggers (see migration 0500). */
export const WEBHOOK_EVENTS = [
  "conversation.created",
  "message.created",
  "handoff.requested",
  "contact.created",
  "contact.updated",
  "booking.created",
  "lead.qualified",
  "ticket.created",
  "ticket.updated",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Test pings are sent regardless of subscription. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

/**
 * Emit a custom event from code (most events come from DB triggers). Must run inside the tenant's own
 * `withTenant` transaction. Returns how many deliveries were queued.
 */
export async function emitWebhookEvent(tx: Tx, tenantId: string, type: WebhookEventType, data: Record<string, unknown>): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT webhook_emit(${tenantId}::uuid, ${type}, ${tx.json(data as never)}) AS n`;
  return Number(r?.n ?? 0);
}

export interface WebhookEnvelope<T = Record<string, unknown>> {
  /** Stable per event; identical across redeliveries and across webhooks. Use it to de-duplicate. */
  id: string;
  type: string;
  createdAt: string;
  tenantId: string;
  data: T;
}
