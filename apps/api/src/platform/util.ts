import type { Context } from "hono";
import type { z } from "zod";
import { AuditLogRepository, type Tx } from "@yulona/db";
import type { AppEnv } from "../context";
import { Errors } from "../errors";

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export function parseId(c: Context, name = "id"): string {
  const v = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw Errors.notFound();
  return v;
}

/** Record an audit entry for the authenticated actor inside the caller's tenant transaction. */
export function audit(
  tx: Tx, c: Context<AppEnv>, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown> = {},
) {
  const a = c.get("auth");
  return new AuditLogRepository(tx, a.tenantId).record({
    actorUserId: a.userId, action, resourceType, resourceId,
    metadata: a.impersonatorId ? { ...metadata, impersonatorId: a.impersonatorId } : metadata, ip: c.get("ip"), requestId: c.get("requestId"),
  });
}

export const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";
export const isFkViolation = (e: unknown) => (e as { code?: string }).code === "23503";
