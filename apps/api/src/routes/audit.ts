import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { parseQuery } from "../platform/util";

const querySchema = z.object({
  action: z.string().max(100).optional(),
  actorUserId: z.uuid().optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(100).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

interface Row {
  id: string; actorUserId: string | null; action: string; resourceType: string | null; resourceId: string | null;
  metadata: unknown; ip: string | null; requestId: string | null; createdAt: Date;
}

export function auditRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.use("/audit-logs/*", requireAuth(cfg), requireMinRole("admin"));

  /** Newest first, keyset-paginated: `cursor` = "<createdAt ISO>|<id>" returned as nextCursor. */
  r.get("/audit-logs", async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, querySchema);
    let cur: { at: string; id: string } | undefined;
    if (q.cursor) {
      const [at, id] = q.cursor.split("|");
      if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
      cur = { at, id };
    }
    const rows = await withTenant(db, tenantId, (tx) => tx<Row[]>`
      SELECT id, actor_user_id, action, resource_type, resource_id, metadata, ip, request_id,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso, created_at
      FROM audit_logs
      WHERE tenant_id = ${tenantId}
        ${q.action ? tx`AND action = ${q.action}` : tx``}
        ${q.actorUserId ? tx`AND actor_user_id = ${q.actorUserId}` : tx``}
        ${q.resourceType ? tx`AND resource_type = ${q.resourceType}` : tx``}
        ${q.resourceId ? tx`AND resource_id = ${q.resourceId}` : tx``}
        ${q.from ? tx`AND created_at >= ${q.from}::timestamptz` : tx``}
        ${q.to ? tx`AND created_at <= ${q.to}::timestamptz` : tx``}
        ${cur ? tx`AND (created_at, id) < (${cur.at}::timestamptz, ${cur.id}::uuid)` : tx``}
      ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit) as (Row & { createdAtIso: string })[];
    const next = rows.length > q.limit ? page[page.length - 1] : undefined;
    return c.json({
      items: page.map((x) => ({
        id: x.id, actorUserId: x.actorUserId, action: x.action, resourceType: x.resourceType, resourceId: x.resourceId,
        metadata: x.metadata, ip: x.ip, requestId: x.requestId, createdAt: x.createdAtIso,
      })),
      nextCursor: next ? `${next.createdAtIso}|${next.id}` : null,
    });
  });
  return r;
}
