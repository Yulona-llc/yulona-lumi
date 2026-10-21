import { Hono } from "hono";
import { withTenant, type Tx } from "@yulona/db";
import { createTagSchema, setTagsSchema, tagResourcesQuerySchema, updateTagSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { audit, isUniqueViolation, parseId, parseQuery } from "../platform/util";
import { decodeCur, encodeCur, guard, iso, TS_FMT, type OpsDeps } from "./common";

interface TagRow { id: string; name: string; color: string; count?: number }
const TYPES = { conversations: ["conversation", "conversations"], contacts: ["contact", "contacts"], tickets: ["ticket", "tickets"] } as const;

export function tagRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();

  r.get("/tags", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const items = await withTenant(db, tenantId, (tx) => tx<TagRow[]>`
      SELECT g.id, g.name, g.color, (SELECT count(*)::int FROM taggables t WHERE t.tenant_id = g.tenant_id AND t.tag_id = g.id) AS count
      FROM tags g WHERE g.tenant_id = ${tenantId} ORDER BY lower(g.name)`);
    return c.json({ items });
  });

  r.post("/tags", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, createTagSchema);
    try {
      const row = await withTenant(db, tenantId, async (tx) => {
        const [x] = await tx<TagRow[]>`INSERT INTO tags (tenant_id, name, color) VALUES (${tenantId}, ${b.name}, COALESCE(${b.color ?? null}, '#6b7280')) RETURNING id, name, color`;
        await audit(tx, c, "tag.create", "tag", x!.id, { name: b.name });
        return x!;
      });
      return c.json({ ...row, count: 0 }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A tag with this name already exists");
      throw e;
    }
  });

  r.patch("/tags/:id", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, updateTagSchema);
    try {
      const row = await withTenant(db, tenantId, async (tx) => {
        const [x] = await tx<TagRow[]>`
          UPDATE tags SET name = COALESCE(${b.name ?? null}, name), color = COALESCE(${b.color ?? null}, color)
          WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id, name, color`;
        if (x) await audit(tx, c, "tag.update", "tag", id, { fields: Object.keys(b) });
        return x;
      });
      if (!row) throw Errors.notFound("Tag not found");
      return c.json(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A tag with this name already exists");
      throw e;
    }
  });

  r.delete("/tags/:id", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`DELETE FROM tags WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (rows.length) await audit(tx, c, "tag.delete", "tag", id);
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("Tag not found");
    return c.json({ ok: true as const });
  });

  r.get("/tags/:id/resources", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const q = parseQuery(c, tagResourcesQuerySchema);
    const cur = decodeCur(q.cursor);
    const rows = await withTenant(db, tenantId, async (tx) => {
      const [t] = await tx`SELECT 1 FROM tags WHERE tenant_id = ${tenantId} AND id = ${id}`;
      if (!t) return null;
      return tx<{ resourceId: string; createdAt: Date; ts: string }[]>`
        SELECT resource_id, created_at, to_char(created_at AT TIME ZONE 'UTC', ${TS_FMT}) AS ts FROM taggables
        WHERE tenant_id = ${tenantId} AND tag_id = ${id} AND resource_type = ${q.type}
          ${cur ? tx`AND (created_at, resource_id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx``}
        ORDER BY created_at DESC, resource_id DESC LIMIT ${q.limit + 1}`;
    });
    if (!rows) throw Errors.notFound("Tag not found");
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map((x) => ({ resourceId: x.resourceId, createdAt: iso(x.createdAt) })), nextCursor: rows.length > q.limit && last ? encodeCur(last.ts, last.resourceId) : null });
  });

  const tagsOf = (tx: Tx, tenantId: string, type: string, rid: string) => tx<TagRow[]>`
    SELECT g.id, g.name, g.color FROM taggables t JOIN tags g ON g.tenant_id = t.tenant_id AND g.id = t.tag_id
    WHERE t.tenant_id = ${tenantId} AND t.resource_type = ${type} AND t.resource_id = ${rid} ORDER BY lower(g.name)`;
  const exists = async (tx: Tx, tenantId: string, table: string, id: string) =>
    (await tx`SELECT 1 FROM ${tx(table)} WHERE tenant_id = ${tenantId} AND id = ${id}`).length > 0;

  for (const [path, [type, table]] of Object.entries(TYPES)) {
    r.get(`/${path}/:id/tags`, guard(cfg, "viewer"), async (c) => {
      const { tenantId } = c.get("auth");
      const id = parseId(c);
      const items = await withTenant(db, tenantId, async (tx) => ((await exists(tx, tenantId, table, id)) ? tagsOf(tx, tenantId, type, id) : null));
      if (!items) throw Errors.notFound();
      return c.json({ items });
    });
    r.put(`/${path}/:id/tags`, guard(cfg, "agent"), async (c) => {
      const { tenantId } = c.get("auth");
      const id = parseId(c);
      const b = await parseBody(c, setTagsSchema);
      const ids = [...new Set(b.tagIds)];
      const items = await withTenant(db, tenantId, async (tx) => {
        if (!(await exists(tx, tenantId, table, id))) return null;
        if (ids.length) {
          const found = await tx<{ id: string }[]>`SELECT id FROM tags WHERE tenant_id = ${tenantId} AND id = ANY(${tx.array(ids)}::uuid[])`;
          if (found.length !== ids.length) throw Errors.validation([{ path: "tagIds", message: "Unknown tag id" }]);
        }
        await tx`DELETE FROM taggables WHERE tenant_id = ${tenantId} AND resource_type = ${type} AND resource_id = ${id}
                 AND NOT (tag_id = ANY(${tx.array(ids)}::uuid[]))`;
        for (const t of ids) {
          await tx`INSERT INTO taggables (tenant_id, tag_id, resource_type, resource_id) VALUES (${tenantId}, ${t}, ${type}, ${id}) ON CONFLICT DO NOTHING`;
        }
        await audit(tx, c, "tags.assign", type, id, { tagIds: ids });
        return tagsOf(tx, tenantId, type, id);
      });
      if (!items) throw Errors.notFound();
      return c.json({ items });
    });
  }
  return r;
}
