import { Hono } from "hono";
import { returnConversationToAi } from "@yulona/ai-runtime";
import { withTenant, type Tx } from "@yulona/db";
import { notifyUser } from "@yulona/ops";
import { assignHandoffSchema, claimHandoffSchema, listHandoffsQuerySchema, resolveHandoffSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { hasMinRole } from "../platform/authz";
import { audit, parseId, parseQuery } from "../platform/util";
import { decodeCur, encodeCur, guard, iso, TS_FMT, type OpsDeps } from "./common";

interface Row {
  id: string; type: string; reason: string; summary: string | null; leadCard: unknown; context: unknown; outOfHours: boolean;
  assignedUserId: string | null; assignedUserName: string | null; claimedAt: Date | null; resolvedAt: Date | null; resolvedBy: string | null;
  resolutionNote: string | null; createdAt: Date; ts: string;
  convId: string; convStatus: string; convHandler: string; channel: string; convAssigned: string | null; lastMessagePreview: string | null; lastMessageAt: Date;
  contactId: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
}
const dto = (h: Row) => ({
  id: h.id, type: h.type, reason: h.reason, summary: h.summary, leadCard: h.leadCard, context: h.context, outOfHours: h.outOfHours,
  state: h.resolvedAt ? "resolved" : h.claimedAt ? "claimed" : "open",
  assignedUserId: h.assignedUserId, assignedUserName: h.assignedUserName, claimedAt: iso(h.claimedAt), resolvedAt: iso(h.resolvedAt),
  resolvedBy: h.resolvedBy, resolutionNote: h.resolutionNote, createdAt: iso(h.createdAt),
  conversation: { id: h.convId, status: h.convStatus, handler: h.convHandler, channel: h.channel, assignedUserId: h.convAssigned, lastMessagePreview: h.lastMessagePreview, lastMessageAt: iso(h.lastMessageAt) },
  contact: { id: h.contactId, name: h.contactName, email: h.contactEmail, phone: h.contactPhone },
});
const select = (tx: Tx) => tx`
  h.id, h.type, h.reason, h.summary, h.lead_card, h.context, h.out_of_hours, h.assigned_user_id, au.name AS assigned_user_name, h.claimed_at, h.resolved_at,
  h.resolved_by, h.resolution_note, h.created_at, to_char(h.created_at AT TIME ZONE 'UTC', ${TS_FMT}) AS ts,
  c.id AS conv_id, c.status AS conv_status, c.handler AS conv_handler, c.channel, c.assigned_user_id AS conv_assigned, c.last_message_preview, c.last_message_at,
  ct.id AS contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone
  FROM handoffs h
  JOIN conversations c ON c.tenant_id = h.tenant_id AND c.id = h.conversation_id
  JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
  LEFT JOIN users au ON au.tenant_id = h.tenant_id AND au.id = h.assigned_user_id`;

export function handoffRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();
  const get = async (tx: Tx, tenantId: string, id: string) => (await tx<Row[]>`SELECT ${select(tx)} WHERE h.tenant_id = ${tenantId} AND h.id = ${id}`)[0];

  r.get("/needs-attention", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const q = parseQuery(c, listHandoffsQuerySchema);
    const cur = decodeCur(q.cursor);
    const desc = q.state === "resolved";
    const rows = await withTenant(db, tenantId, (tx) => tx<Row[]>`
      SELECT ${select(tx)} WHERE h.tenant_id = ${tenantId}
        ${q.state === "open" ? tx`AND h.resolved_at IS NULL AND h.claimed_at IS NULL` : q.state === "claimed" ? tx`AND h.resolved_at IS NULL AND h.claimed_at IS NOT NULL`
          : q.state === "resolved" ? tx`AND h.resolved_at IS NOT NULL` : tx`AND h.resolved_at IS NULL`}
        ${q.type ? tx`AND h.type = ANY(${tx.array(q.type as string[])}::text[])` : tx``}
        ${q.assignee === "me" ? tx`AND h.assigned_user_id = ${userId}` : q.assignee === "unassigned" ? tx`AND h.assigned_user_id IS NULL` : q.assignee ? tx`AND h.assigned_user_id = ${q.assignee}` : tx``}
        ${cur ? (desc ? tx`AND (h.created_at, h.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx`AND (h.created_at, h.id) > (${cur.ts}::timestamptz, ${cur.id}::uuid)`) : tx``}
      ${desc ? tx`ORDER BY h.created_at DESC, h.id DESC` : tx`ORDER BY h.created_at, h.id`} LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(dto), nextCursor: rows.length > q.limit && last ? encodeCur(last.ts, last.id) : null });
  });

  r.get("/needs-attention/counts", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => tx<{ type: string; n: number; mine: number }[]>`
      SELECT type, count(*)::int AS n, (count(*) FILTER (WHERE assigned_user_id = ${userId}))::int AS mine
      FROM handoffs WHERE tenant_id = ${tenantId} AND resolved_at IS NULL GROUP BY type`);
    const n = (t: string) => rows.find((x) => x.type === t)?.n ?? 0;
    return c.json({ uncertainty: n("uncertainty"), stage: n("stage"), system_failure: n("system_failure"), abuse: n("abuse"), total: rows.reduce((a, x) => a + x.n, 0), mine: rows.reduce((a, x) => a + x.mine, 0) });
  });

  r.get("/needs-attention/:id", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const h = await withTenant(db, tenantId, (tx) => get(tx, tenantId, parseId(c)));
    if (!h) throw Errors.notFound("Handoff not found");
    return c.json(dto(h));
  });

  /** Take the conversation for `userId` (claim/assign): handler=human, assigned, status open. */
  const takeOver = async (tx: Tx, tenantId: string, h: Row, userId: string) => {
    await tx`UPDATE handoffs SET assigned_user_id = ${userId}, claimed_at = now() WHERE tenant_id = ${tenantId} AND id = ${h.id}`;
    await tx`UPDATE conversations SET handler = 'human', assigned_user_id = ${userId}, status = 'open', updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${h.convId}`;
  };
  const lock = async (tx: Tx, tenantId: string, id: string) => {
    const [x] = await tx`SELECT 1 FROM handoffs WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    return x ? get(tx, tenantId, id) : undefined;
  };

  r.post("/needs-attention/:id/claim", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, claimHandoffSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const h = await lock(tx, tenantId, id);
      if (!h) return null;
      if (h.resolvedAt) throw Errors.conflict("Handoff is already resolved");
      if (h.claimedAt && h.assignedUserId !== userId && !(b.force && hasMinRole(role, "admin"))) throw Errors.conflict("Handoff is already claimed by someone else");
      await takeOver(tx, tenantId, h, userId);
      await audit(tx, c, "handoff.claim", "handoff", id, { conversationId: h.convId, forced: !!b.force });
      return get(tx, tenantId, id);
    });
    if (!out) throw Errors.notFound("Handoff not found");
    return c.json(dto(out));
  });

  r.post("/needs-attention/:id/assign", guard(cfg, "admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, assignHandoffSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const h = await lock(tx, tenantId, id);
      if (!h) return null;
      if (h.resolvedAt) throw Errors.conflict("Handoff is already resolved");
      const [u] = await tx`SELECT 1 FROM users WHERE tenant_id = ${tenantId} AND id = ${b.userId} AND status = 'active' AND role IN ('owner','admin','agent')`;
      if (!u) throw Errors.validation([{ path: "userId", message: "User not found or cannot handle conversations" }]);
      await takeOver(tx, tenantId, h, b.userId);
      if (b.userId !== userId) {
        await notifyUser(tx, tenantId, b.userId, {
          type: "handoff.assigned", title: "A conversation was assigned to you", body: h.reason,
          data: { handoffId: id, conversationId: h.convId, type: h.type }, email: true,
        });
      }
      await audit(tx, c, "handoff.assign", "handoff", id, { conversationId: h.convId, assignedUserId: b.userId });
      return get(tx, tenantId, id);
    });
    if (!out) throw Errors.notFound("Handoff not found");
    return c.json(dto(out));
  });

  r.post("/needs-attention/:id/release", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const id = parseId(c);
    const out = await withTenant(db, tenantId, async (tx) => {
      const h = await lock(tx, tenantId, id);
      if (!h) return null;
      if (h.resolvedAt) throw Errors.conflict("Handoff is already resolved");
      if (!h.claimedAt) throw Errors.conflict("Handoff is not claimed");
      if (h.assignedUserId !== userId && !hasMinRole(role, "admin")) throw Errors.forbidden("Only the assignee or an admin can release this handoff");
      await tx`UPDATE handoffs SET assigned_user_id = NULL, claimed_at = NULL WHERE tenant_id = ${tenantId} AND id = ${id}`;
      await tx`UPDATE conversations SET handler = 'ai', assigned_user_id = NULL, status = 'pending_human', updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${h.convId}`;
      await audit(tx, c, "handoff.release", "handoff", id, { conversationId: h.convId });
      return get(tx, tenantId, id);
    });
    if (!out) throw Errors.notFound("Handoff not found");
    return c.json(dto(out));
  });

  r.post("/needs-attention/:id/resolve", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, resolveHandoffSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const h = await lock(tx, tenantId, id);
      if (!h) return null;
      if (h.resolvedAt) throw Errors.conflict("Handoff is already resolved");
      // resolve every open handoff of the conversation (one conversation, one outcome)
      await tx`UPDATE handoffs SET resolved_at = now(), resolved_by = ${userId}, resolution_note = ${b.note ?? null}
               WHERE tenant_id = ${tenantId} AND conversation_id = ${h.convId} AND resolved_at IS NULL`;
      // a blocked contact never goes back to the AI: the handoff is resolved, the conversation stays as it is
      const [blk] = await tx<{ b: boolean }[]>`SELECT EXISTS (SELECT 1 FROM contacts ct JOIN conversations c ON c.tenant_id = ct.tenant_id AND c.contact_id = ct.id
        WHERE c.tenant_id = ${tenantId} AND c.id = ${h.convId} AND ct.blocked_at IS NOT NULL) AS b`;
      if (b.returnToAi && !blk?.b) {
        await tx`UPDATE conversations SET handler = 'ai', assigned_user_id = NULL, status = 'open', updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${h.convId}`;
        await returnConversationToAi(tx, tenantId, h.convId);
        await tx`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, metadata)
                 VALUES (${tenantId}, ${h.convId}, 'system', 'Conversation returned to AI', ${tx.json({ event: "returned_to_ai" } as never)})`;
      } else if (h.convStatus === "pending_human") {
        await tx`UPDATE conversations SET handler = 'human', status = 'open', assigned_user_id = COALESCE(assigned_user_id, ${userId}), updated_at = now()
                 WHERE tenant_id = ${tenantId} AND id = ${h.convId}`;
      }
      await audit(tx, c, "handoff.resolve", "handoff", id, { conversationId: h.convId, returnToAi: !!b.returnToAi });
      return get(tx, tenantId, id);
    });
    if (!out) throw Errors.notFound("Handoff not found");
    return c.json(dto(out));
  });
  return r;
}
