import type { Tx } from "@yulona/db";

export type NotificationType = "handoff.requested" | "handoff.assigned" | "ticket.assigned" | "ticket.sla_breached" | "booking.created" | "booking.failed";

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  /** queue an email (honours the user's preference) */
  email?: boolean;
}

/** Notify one user (SQL helper `ops_notify` applies the email preference). */
export async function notifyUser(tx: Tx, tenantId: string, userId: string, n: NotifyInput): Promise<void> {
  await tx`SELECT ops_notify(${tenantId}::uuid, ${userId}::uuid, ${n.type}, ${n.title}, ${n.body ?? null}, ${tx.json((n.data ?? {}) as never)}, ${n.email ?? false})`;
}

/** Notify every active user holding one of `roles`. */
export async function notifyRoles(tx: Tx, tenantId: string, roles: string[], n: NotifyInput): Promise<number> {
  const users = await tx<{ id: string }[]>`
    SELECT id FROM users WHERE tenant_id = ${tenantId} AND status = 'active' AND role = ANY(${tx.array(roles)}::text[])`;
  for (const u of users) await notifyUser(tx, tenantId, u.id, n);
  return users.length;
}
