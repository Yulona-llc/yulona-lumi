import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { listNotificationsQuerySchema, notificationPrefsSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { parseId, parseQuery } from "../platform/util";
import { decodeCur, encodeCur, guard, iso, TS_FMT, type OpsDeps } from "./common";

interface Row { id: string; type: string; title: string; body: string | null; data: unknown; readAt: Date | null; createdAt: Date; ts: string }

export function notificationRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();

  r.get("/notifications", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const q = parseQuery(c, listNotificationsQuerySchema);
    const cur = decodeCur(q.cursor);
    const { rows, unreadCount } = await withTenant(db, tenantId, async (tx) => ({
      rows: await tx<Row[]>`
        SELECT id, type, title, body, data, read_at, created_at, to_char(created_at AT TIME ZONE 'UTC', ${TS_FMT}) AS ts
        FROM notifications WHERE tenant_id = ${tenantId} AND user_id = ${userId}
          ${q.unread ? tx`AND read_at IS NULL` : tx``}
          ${cur ? tx`AND (created_at, id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx``}
        ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`,
      unreadCount: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND read_at IS NULL`)[0]!.n,
    }));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({
      items: page.map((x) => ({ id: x.id, type: x.type, title: x.title, body: x.body, data: x.data, readAt: iso(x.readAt), createdAt: iso(x.createdAt) })),
      nextCursor: rows.length > q.limit && last ? encodeCur(last.ts, last.id) : null,
      unreadCount,
    });
  });

  r.post("/notifications/read-all", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const n = await withTenant(db, tenantId, async (tx) =>
      (await tx`UPDATE notifications SET read_at = now() WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND read_at IS NULL RETURNING id`).length);
    return c.json({ updated: n });
  });

  r.post("/notifications/:id/read", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) =>
      (await tx`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND id = ${id} RETURNING id`).length > 0);
    if (!ok) throw Errors.notFound();
    return c.json({ ok: true as const });
  });

  r.get("/notifications/preferences", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const [p] = await withTenant(db, tenantId, (tx) => tx<{ emailEnabled: boolean }[]>`SELECT email_enabled FROM notification_prefs WHERE tenant_id = ${tenantId} AND user_id = ${userId}`);
    return c.json({ email: p?.emailEnabled ?? true });
  });

  r.put("/notifications/preferences", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, notificationPrefsSchema);
    await withTenant(db, tenantId, (tx) => tx`
      INSERT INTO notification_prefs (tenant_id, user_id, email_enabled) VALUES (${tenantId}, ${userId}, ${b.email})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET email_enabled = EXCLUDED.email_enabled, updated_at = now()`);
    return c.json({ email: b.email });
  });
  return r;
}
