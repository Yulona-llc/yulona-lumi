import { Hono } from "hono";
import { withTenant, type Tx } from "@yulona/db";
import { notifyUser } from "@yulona/ops";
import {
  bulkTicketsSchema, createTicketSchema, listTicketsQuerySchema, ticketBoardQuerySchema, ticketCommentSchema, ticketEventsQuerySchema,
  ticketPrioritySchema, ticketStatusSchema, TICKET_STATUSES, updateTicketSchema,
} from "@yulona/shared";
import { z } from "zod";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { audit, isFkViolation, parseId, parseQuery } from "../platform/util";
import { decodeCur, encodeCur, guard, iso, TS_FMT, type OpsDeps } from "./common";

type Filters = Partial<z.infer<typeof ticketBoardQuerySchema>> & { status?: string[] };
const DEFAULT_SLA: Record<string, number> = { urgent: 60, high: 240, normal: 1440, low: 4320 };

interface TicketRow {
  id: string; number: string | number; title: string; description: string; status: string; priority: string;
  assigneeUserId: string | null; assigneeName: string | null; contactId: string | null; contactName: string | null;
  conversationId: string | null; dueAt: Date | null; slaBreachedAt: Date | null; resolvedAt: Date | null; createdBy: string | null;
  createdAt: Date; updatedAt: Date; tags: unknown; ts?: string;
}
const dto = (t: TicketRow) => ({
  id: t.id, number: Number(t.number), title: t.title, description: t.description, status: t.status, priority: t.priority,
  assigneeUserId: t.assigneeUserId, assigneeName: t.assigneeName, contactId: t.contactId, contactName: t.contactName,
  conversationId: t.conversationId, dueAt: iso(t.dueAt), slaBreachedAt: iso(t.slaBreachedAt), resolvedAt: iso(t.resolvedAt),
  createdBy: t.createdBy, tags: t.tags ?? [], createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt),
});

const select = (tx: Tx) => tx`
  t.id, t.number, t.title, t.description, t.status, t.priority, t.assignee_user_id, au.name AS assignee_name, t.contact_id, ct.name AS contact_name,
  t.conversation_id, t.due_at, t.sla_breached_at, t.resolved_at, t.created_by, t.created_at, t.updated_at,
  to_char(t.created_at AT TIME ZONE 'UTC', ${TS_FMT}) AS ts,
  COALESCE((SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'color', g.color) ORDER BY lower(g.name))
            FROM taggables tg JOIN tags g ON g.tenant_id = tg.tenant_id AND g.id = tg.tag_id
            WHERE tg.tenant_id = t.tenant_id AND tg.resource_type = 'ticket' AND tg.resource_id = t.id), '[]'::json) AS tags
  FROM tickets t
  LEFT JOIN users au ON au.tenant_id = t.tenant_id AND au.id = t.assignee_user_id
  LEFT JOIN contacts ct ON ct.tenant_id = t.tenant_id AND ct.id = t.contact_id`;

const where = (tx: Tx, tenantId: string, userId: string, f: Filters) => tx`
  t.tenant_id = ${tenantId}
  ${f.status ? tx`AND t.status = ANY(${tx.array(f.status)}::text[])` : tx``}
  ${f.priority ? tx`AND t.priority = ANY(${tx.array(f.priority as string[])}::text[])` : tx``}
  ${f.assignee === "me" ? tx`AND t.assignee_user_id = ${userId}` : f.assignee === "unassigned" ? tx`AND t.assignee_user_id IS NULL` : f.assignee ? tx`AND t.assignee_user_id = ${f.assignee}` : tx``}
  ${f.contactId ? tx`AND t.contact_id = ${f.contactId}` : tx``}
  ${f.conversationId ? tx`AND t.conversation_id = ${f.conversationId}` : tx``}
  ${f.tagId ? tx`AND EXISTS (SELECT 1 FROM taggables tg WHERE tg.tenant_id = t.tenant_id AND tg.resource_type = 'ticket' AND tg.resource_id = t.id AND tg.tag_id = ${f.tagId})` : tx``}
  ${f.slaBreached ? tx`AND t.sla_breached_at IS NOT NULL` : tx``}
  ${f.q ? tx`AND (t.title ILIKE ${"%" + f.q.replace(/[\\%_]/g, "\\$&") + "%"} OR t.description ILIKE ${"%" + f.q.replace(/[\\%_]/g, "\\$&") + "%"}
              ${/^#?\d{1,15}$/.test(f.q) ? tx`OR t.number = ${Number(f.q.replace("#", ""))}` : tx``})` : tx``}`;

async function slaMinutes(tx: Tx, tenantId: string): Promise<Record<string, number>> {
  const [s] = await tx<{ slaMinutes: Record<string, number> }[]>`SELECT sla_minutes FROM ops_settings WHERE tenant_id = ${tenantId}`;
  return { ...DEFAULT_SLA, ...(s?.slaMinutes ?? {}) };
}

const addEvent = (tx: Tx, tenantId: string, ticketId: string, actor: string | null, type: string, data: Record<string, unknown> = {}) =>
  tx`INSERT INTO ticket_events (tenant_id, ticket_id, actor_user_id, type, data) VALUES (${tenantId}, ${ticketId}, ${actor}, ${type}, ${tx.json(data as never)})`;

type Patch = z.infer<typeof updateTicketSchema>;

/** Apply a validated patch to one ticket (shared by PATCH and bulk). Returns false when the ticket does not exist. */
export async function applyTicketPatch(tx: Tx, tenantId: string, actor: string, id: string, p: Patch, bulk = false): Promise<boolean> {
  const [cur] = await tx<{ status: string; priority: string; assigneeUserId: string | null; dueAt: Date | null; createdAt: Date; resolvedAt: Date | null; slaBreachedAt: Date | null; number: string; title: string }[]>`
    SELECT status, priority, assignee_user_id, due_at, created_at, resolved_at, sla_breached_at, number, title FROM tickets WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  if (!cur) return false;
  const status = p.status ?? cur.status;
  const priority = p.priority ?? cur.priority;
  let dueAt: Date | null = cur.dueAt;
  if (p.dueAt !== undefined) dueAt = p.dueAt ? new Date(p.dueAt) : null;
  else if (p.priority !== undefined && p.priority !== cur.priority) {
    const sla = await slaMinutes(tx, tenantId);
    dueAt = new Date(cur.createdAt.getTime() + (sla[priority] ?? DEFAULT_SLA[priority]!) * 60_000);
  }
  const closing = status === "resolved" || status === "closed";
  const resolvedAt = closing ? (cur.resolvedAt ?? new Date()) : null;
  const breached = dueAt && dueAt.getTime() > Date.now() ? null : cur.slaBreachedAt;
  const assignee = p.assigneeUserId !== undefined ? p.assigneeUserId : cur.assigneeUserId;
  await tx`
    UPDATE tickets SET
      title = COALESCE(${p.title ?? null}, title),
      description = COALESCE(${p.description ?? null}, description),
      status = ${status}, priority = ${priority}, assignee_user_id = ${assignee},
      contact_id = ${p.contactId !== undefined ? p.contactId : tx`contact_id`},
      conversation_id = ${p.conversationId !== undefined ? p.conversationId : tx`conversation_id`},
      due_at = ${dueAt}, resolved_at = ${resolvedAt}, sla_breached_at = ${breached}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${id}`;
  const b = bulk ? { bulk: true } : {};
  if (status !== cur.status) await addEvent(tx, tenantId, id, actor, "status_changed", { from: cur.status, to: status, ...b });
  if (priority !== cur.priority) await addEvent(tx, tenantId, id, actor, "priority_changed", { from: cur.priority, to: priority, ...b });
  if (assignee !== cur.assigneeUserId) {
    await addEvent(tx, tenantId, id, actor, "assigned", { from: cur.assigneeUserId, to: assignee, ...b });
    if (assignee && assignee !== actor) {
      await notifyUser(tx, tenantId, assignee, { type: "ticket.assigned", title: `Ticket #${cur.number} assigned to you`, body: cur.title, data: { ticketId: id, number: Number(cur.number) }, email: true });
    }
  }
  const other = ["title", "description", "dueAt", "contactId", "conversationId"].filter((k) => (p as Record<string, unknown>)[k] !== undefined);
  if (other.length) await addEvent(tx, tenantId, id, actor, "updated", { fields: other, ...b });
  return true;
}

export function ticketRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();

  r.get("/tickets", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const q = parseQuery(c, listTicketsQuerySchema);
    const cur = decodeCur(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) => tx<TicketRow[]>`
      SELECT ${select(tx)} WHERE ${where(tx, tenantId, userId, q)}
      ${cur ? tx`AND (t.created_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx``}
      ORDER BY t.created_at DESC, t.id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(dto), nextCursor: rows.length > q.limit && last ? encodeCur(last.ts!, last.id) : null });
  });

  r.get("/tickets/board", guard(cfg, "viewer"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const q = parseQuery(c, ticketBoardQuerySchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const columns: Record<string, ReturnType<typeof dto>[]> = {};
      for (const s of TICKET_STATUSES) {
        const rows = await tx<TicketRow[]>`SELECT ${select(tx)} WHERE ${where(tx, tenantId, userId, { ...q, status: [s] })} ORDER BY t.updated_at DESC, t.id DESC LIMIT 50`;
        columns[s] = rows.map(dto);
      }
      const totals = await tx<{ status: string; n: number }[]>`SELECT t.status, count(*)::int AS n FROM tickets t WHERE ${where(tx, tenantId, userId, q)} GROUP BY t.status`;
      return { columns, totals: Object.fromEntries(TICKET_STATUSES.map((s) => [s, totals.find((x) => x.status === s)?.n ?? 0])) };
    });
    return c.json(out);
  });

  r.post("/tickets", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, createTicketSchema);
    try {
      const out = await withTenant(db, tenantId, async (tx) => {
        const priority = b.priority ?? "normal";
        const [ctr] = await tx<{ last: string }[]>`
          INSERT INTO ticket_counters (tenant_id, last) VALUES (${tenantId}, 1)
          ON CONFLICT (tenant_id) DO UPDATE SET last = ticket_counters.last + 1 RETURNING last`;
        const sla = await slaMinutes(tx, tenantId);
        const due = b.dueAt ? new Date(b.dueAt) : new Date(Date.now() + (sla[priority] ?? 1440) * 60_000);
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO tickets (tenant_id, number, title, description, priority, assignee_user_id, contact_id, conversation_id, due_at, created_by)
          VALUES (${tenantId}, ${ctr!.last}, ${b.title}, ${b.description ?? ""}, ${priority}, ${b.assigneeUserId ?? null}, ${b.contactId ?? null},
                  ${b.conversationId ?? null}, ${due}, ${userId}) RETURNING id`;
        const id = row!.id;
        await addEvent(tx, tenantId, id, userId, "created", { priority });
        await audit(tx, c, "ticket.create", "ticket", id, { number: Number(ctr!.last) });
        if (b.assigneeUserId && b.assigneeUserId !== userId) {
          await notifyUser(tx, tenantId, b.assigneeUserId, { type: "ticket.assigned", title: `Ticket #${ctr!.last} assigned to you`, body: b.title, data: { ticketId: id, number: Number(ctr!.last) }, email: true });
        }
        const [t] = await tx<TicketRow[]>`SELECT ${select(tx)} WHERE t.tenant_id = ${tenantId} AND t.id = ${id}`;
        return t!;
      });
      return c.json(dto(out), 201);
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "reference", message: "assignee, contact or conversation not found" }]);
      throw e;
    }
  });

  r.post("/tickets/bulk", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const b = await parseBody(c, bulkTicketsSchema);
    const ids = [...new Set(b.ids)];
    try {
    let patch: Patch | null = null;
    if (b.action === "set_status") patch = { status: ticketStatusSchema.parse(b.value) };
    else if (b.action === "set_priority") patch = { priority: ticketPrioritySchema.parse(b.value) };
    else if (b.action === "assign") patch = { assigneeUserId: b.value ? z.uuid().parse(b.value) : null };
    else if (role !== "admin" && role !== "owner") throw Errors.forbidden("Deleting tickets requires admin");
      const res = await withTenant(db, tenantId, async (tx) => {
        let updated = 0;
        for (const id of ids) {
          if (patch) {
            if (await applyTicketPatch(tx, tenantId, userId, id, patch, true)) updated++;
          } else {
            await tx`DELETE FROM taggables WHERE tenant_id = ${tenantId} AND resource_type = 'ticket' AND resource_id = ${id}`;
            updated += (await tx`DELETE FROM tickets WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`).length;
          }
        }
        await audit(tx, c, "ticket.bulk", "ticket", ids[0]!, { action: b.action, count: ids.length, updated });
        return { updated, skipped: ids.length - updated };
      });
      return c.json(res);
    } catch (e) {
      if (e instanceof z.ZodError) throw Errors.validation([{ path: "value", message: "Invalid value for this action" }]);
      if (isFkViolation(e)) throw Errors.validation([{ path: "value", message: "User not found" }]);
      throw e;
    }
  });

  r.get("/tickets/:id", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const [t] = await withTenant(db, tenantId, (tx) => tx<TicketRow[]>`SELECT ${select(tx)} WHERE t.tenant_id = ${tenantId} AND t.id = ${id}`);
    if (!t) throw Errors.notFound("Ticket not found");
    return c.json(dto(t));
  });

  r.patch("/tickets/:id", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, updateTicketSchema);
    try {
      const t = await withTenant(db, tenantId, async (tx) => {
        if (!(await applyTicketPatch(tx, tenantId, userId, id, b))) return null;
        await audit(tx, c, "ticket.update", "ticket", id, { fields: Object.keys(b) });
        return (await tx<TicketRow[]>`SELECT ${select(tx)} WHERE t.tenant_id = ${tenantId} AND t.id = ${id}`)[0]!;
      });
      if (!t) throw Errors.notFound("Ticket not found");
      return c.json(dto(t));
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "reference", message: "assignee, contact or conversation not found" }]);
      throw e;
    }
  });

  r.delete("/tickets/:id", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      await tx`DELETE FROM taggables WHERE tenant_id = ${tenantId} AND resource_type = 'ticket' AND resource_id = ${id}`;
      const rows = await tx`DELETE FROM tickets WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (rows.length) await audit(tx, c, "ticket.delete", "ticket", id);
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("Ticket not found");
    return c.json({ ok: true as const });
  });

  r.post("/tickets/:id/comments", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, ticketCommentSchema);
    const ev = await withTenant(db, tenantId, async (tx) => {
      const [t] = await tx`SELECT 1 FROM tickets WHERE tenant_id = ${tenantId} AND id = ${id}`;
      if (!t) return null;
      const [e] = await tx<EventRow[]>`
        INSERT INTO ticket_events (tenant_id, ticket_id, actor_user_id, type, data) VALUES (${tenantId}, ${id}, ${userId}, 'comment', ${tx.json({ text: b.text } as never)})
        RETURNING id, ticket_id, actor_user_id, type, data, created_at`;
      await tx`UPDATE tickets SET updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${id}`;
      await audit(tx, c, "ticket.comment", "ticket", id);
      return e!;
    });
    if (!ev) throw Errors.notFound("Ticket not found");
    return c.json(eventDto({ ...ev, actorName: null }), 201);
  });

  r.get("/tickets/:id/events", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const q = parseQuery(c, ticketEventsQuerySchema);
    const cur = decodeCur(q.cursor);
    const rows = await withTenant(db, tenantId, async (tx) => {
      const [t] = await tx`SELECT 1 FROM tickets WHERE tenant_id = ${tenantId} AND id = ${id}`;
      if (!t) return null;
      return tx<(EventRow & { ts: string; actorName: string | null })[]>`
        SELECT e.id, e.ticket_id, e.actor_user_id, u.name AS actor_name, e.type, e.data, e.created_at, to_char(e.created_at AT TIME ZONE 'UTC', ${TS_FMT}) AS ts
        FROM ticket_events e LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.actor_user_id
        WHERE e.tenant_id = ${tenantId} AND e.ticket_id = ${id}
          ${cur ? tx`AND (e.created_at, e.id) > (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx``}
        ORDER BY e.created_at, e.id LIMIT ${q.limit + 1}`;
    });
    if (!rows) throw Errors.notFound("Ticket not found");
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(eventDto), nextCursor: rows.length > q.limit && last ? encodeCur(last.ts, last.id) : null });
  });
  return r;
}

interface EventRow { id: string; ticketId: string; actorUserId: string | null; type: string; data: unknown; createdAt: Date }
const eventDto = (e: EventRow & { actorName?: string | null }) => ({
  id: e.id, ticketId: e.ticketId, actorUserId: e.actorUserId, actorName: e.actorName ?? null, type: e.type, data: e.data, createdAt: iso(e.createdAt),
});
