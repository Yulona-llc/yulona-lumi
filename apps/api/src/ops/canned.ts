import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { createCannedSchema, listCannedQuerySchema, updateCannedSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { audit, isUniqueViolation, parseId, parseQuery } from "../platform/util";
import { hasMinRole } from "../platform/authz";
import { guard, iso, type OpsDeps } from "./common";

interface Row { id: string; shortcut: string; title: string; content: string; createdBy: string | null; createdAt: Date; updatedAt: Date }
const dto = (r: Row) => ({ id: r.id, shortcut: r.shortcut, title: r.title, content: r.content, createdBy: r.createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) });

export function cannedRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();

  r.get("/canned-responses", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listCannedQuerySchema);
    // ordered by (shortcut, id): the cursor carries the last shortcut in the ts slot (not a date), so decode manually
    const cur = q.cursor ? Buffer.from(q.cursor, "base64url").toString("utf8").split("|") : null;
    if (cur && (cur.length !== 2 || !/^[0-9a-f-]{36}$/i.test(cur[1]!))) throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const rows = await withTenant(db, tenantId, (tx) => tx<Row[]>`
      SELECT id, shortcut, title, content, created_by, created_at, updated_at FROM canned_responses
      WHERE tenant_id = ${tenantId}
        ${like ? tx`AND (shortcut ILIKE ${like} OR title ILIKE ${like} OR content ILIKE ${like})` : tx``}
        ${cur ? tx`AND (shortcut, id) > (${cur[0]!}, ${cur[1]!}::uuid)` : tx``}
      ORDER BY shortcut, id LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(dto), nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.shortcut}|${last.id}`).toString("base64url") : null });
  });

  r.post("/canned-responses", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, createCannedSchema);
    try {
      const row = await withTenant(db, tenantId, async (tx) => {
        const [x] = await tx<Row[]>`
          INSERT INTO canned_responses (tenant_id, shortcut, title, content, created_by) VALUES (${tenantId}, ${b.shortcut}, ${b.title}, ${b.content}, ${userId})
          RETURNING id, shortcut, title, content, created_by, created_at, updated_at`;
        await audit(tx, c, "canned_response.create", "canned_response", x!.id, { shortcut: b.shortcut });
        return x!;
      });
      return c.json(dto(row), 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A canned response with this shortcut already exists");
      throw e;
    }
  });

  r.patch("/canned-responses/:id", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, updateCannedSchema);
    try {
      const row = await withTenant(db, tenantId, async (tx) => {
        const [cur] = await tx<{ createdBy: string | null }[]>`SELECT created_by FROM canned_responses WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        if (!cur) return null;
        if (!hasMinRole(role, "admin") && cur.createdBy !== userId) throw Errors.forbidden("Only the author or an admin can edit this response");
        const [x] = await tx<Row[]>`
          UPDATE canned_responses SET shortcut = COALESCE(${b.shortcut ?? null}, shortcut), title = COALESCE(${b.title ?? null}, title),
            content = COALESCE(${b.content ?? null}, content), updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${id}
          RETURNING id, shortcut, title, content, created_by, created_at, updated_at`;
        await audit(tx, c, "canned_response.update", "canned_response", id, { fields: Object.keys(b) });
        return x!;
      });
      if (!row) throw Errors.notFound("Canned response not found");
      return c.json(dto(row));
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A canned response with this shortcut already exists");
      throw e;
    }
  });

  r.delete("/canned-responses/:id", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const [cur] = await tx<{ createdBy: string | null }[]>`SELECT created_by FROM canned_responses WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      if (!cur) return false;
      if (!hasMinRole(role, "admin") && cur.createdBy !== userId) throw Errors.forbidden("Only the author or an admin can delete this response");
      await tx`DELETE FROM canned_responses WHERE tenant_id = ${tenantId} AND id = ${id}`;
      await audit(tx, c, "canned_response.delete", "canned_response", id);
      return true;
    });
    if (!ok) throw Errors.notFound("Canned response not found");
    return c.json({ ok: true as const });
  });
  return r;
}
