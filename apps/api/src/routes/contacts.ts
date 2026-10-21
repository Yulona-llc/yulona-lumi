import { Hono } from "hono";
import { AuditLogRepository, withTenant } from "@yulona/db";
import { createContactSchema, listContactsQuerySchema, mergeContactSchema, timelineQuerySchema, updateContactSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { requireWriteRole } from "../platform/authz";
import { cursorOf, idParam, parseQuery, type ConvDeps } from "../conversations/common";
import { encodeCursor, toContactDto, toMessageDto } from "../conversations/dto";
import { ContactsRepository, ConversationsRepository } from "../conversations/repos";

export function contactRoutes({ cfg, db }: ConvDeps) {
  const r = new Hono<AppEnv>();
  r.use("/contacts", requireAuth(cfg));
  r.use("/contacts/*", requireAuth(cfg));
  // viewers are read-only (found by the role-matrix sweep: they could previously reply, take over, merge and edit)
  r.use("/contacts", requireWriteRole());
  r.use("/contacts/*", requireWriteRole());

  r.get("/contacts", async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listContactsQuerySchema);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) => new ContactsRepository(tx, tenantId).list({ q: q.q, cursor, limit: q.limit }));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(toContactDto), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs, last.id) : null });
  });

  r.post("/contacts", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const body = await parseBody(c, createContactSchema);
    const attrs = Object.fromEntries(Object.entries(body.customAttributes ?? {}).filter(([, v]) => v !== null));
    const dto = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      const id = await repo.create({ ...body, customAttributes: attrs });
      await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "contact.create", resourceType: "contact", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId") });
      return toContactDto((await repo.get(id))!);
    });
    return c.json(dto, 201);
  });

  r.get("/contacts/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, (tx) => new ContactsRepository(tx, tenantId).get(id));
    if (!row || (row as { mergedInto?: string | null }).mergedInto) throw Errors.notFound("Contact not found");
    return c.json(toContactDto(row));
  });

  r.patch("/contacts/:id", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const body = await parseBody(c, updateContactSchema);
    const dto = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      const cur = await repo.get(id, true);
      if (!cur || (cur as { mergedInto?: string | null }).mergedInto) return null;
      let attrs: Record<string, unknown> | undefined;
      if (body.customAttributes) {
        attrs = { ...cur.customAttributes };
        for (const [k, v] of Object.entries(body.customAttributes)) {
          if (v === null) delete attrs[k];
          else attrs[k] = v;
        }
        if (Object.keys(attrs).length > 50) throw Errors.validation([{ path: "customAttributes", message: "Too many attributes" }]);
      }
      await repo.update(id, { name: body.name, email: body.email, phone: body.phone, customAttributes: attrs });
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "contact.update", resourceType: "contact", resourceId: id,
        metadata: { fields: Object.keys(body) }, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return toContactDto((await repo.get(id))!);
    });
    if (!dto) throw Errors.notFound("Contact not found");
    return c.json(dto);
  });

  r.delete("/contacts/:id", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const found = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      if (!(await repo.get(id, true))) return false;
      if (await new ConversationsRepository(tx, tenantId).hasAny(id)) throw Errors.conflict("Contact has conversations and cannot be deleted");
      await repo.delete(id);
      await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "contact.delete", resourceType: "contact", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId") });
      return true;
    });
    if (!found) throw Errors.notFound("Contact not found");
    return c.json({ ok: true as const });
  });

  r.get("/contacts/:id/timeline", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const q = parseQuery(c, timelineQuerySchema);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      if (!(await repo.get(id))) return null;
      return repo.timeline(id, { cursor, limit: q.limit });
    });
    if (!rows) throw Errors.notFound("Contact not found");
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const items = page.map((t) =>
      t.type === "conversation_started"
        ? { type: t.type, at: t.at.toISOString(), conversationId: t.conversationId, channel: t.channel }
        : {
            type: t.type, at: t.at.toISOString(), conversationId: t.conversationId, channel: t.channel,
            message: toMessageDto({
              id: t.itemId, conversationId: t.conversationId, senderType: t.senderType as never, senderUserId: t.senderUserId,
              senderName: t.senderName, content: t.content ?? "", ui: t.ui, metadata: t.metadata ?? {}, createdAt: t.at,
            }),
          },
    );
    return c.json({ items, nextCursor: rows.length > q.limit && last ? encodeCursor(last.atText, last.itemId) : null });
  });

  r.post("/contacts/:id/merge", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const body = await parseBody(c, mergeContactSchema);
    if (body.sourceContactId === id) throw Errors.validation([{ path: "sourceContactId", message: "Cannot merge a contact into itself" }]);
    const dto = await withTenant(db, tenantId, async (tx) => {
      const repo = new ContactsRepository(tx, tenantId);
      // lock in a stable order to avoid deadlocks between concurrent merges
      const [a, b] = [id, body.sourceContactId].sort();
      await repo.get(a!, true);
      await repo.get(b!, true);
      const primary = (await repo.get(id)) as (Awaited<ReturnType<typeof repo.get>> & { mergedInto?: string | null }) | undefined;
      const source = (await repo.get(body.sourceContactId)) as typeof primary;
      if (!primary || !source || primary.mergedInto) return null;
      if (source.mergedInto) throw Errors.conflict("Source contact was already merged");
      await repo.merge(id, body.sourceContactId, userId);
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "contact.merge", resourceType: "contact", resourceId: id,
        metadata: { sourceContactId: body.sourceContactId }, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return toContactDto((await repo.get(id))!);
    });
    if (!dto) throw Errors.notFound("Contact not found");
    return c.json(dto);
  });

  return r;
}
