import { Hono } from "hono";
import { returnConversationToAi } from "@yulona/ai-runtime";
import { AuditLogRepository, UsersRepository, withTenant } from "@yulona/db";
import { listConversationsQuerySchema, listMessagesQuerySchema, patchConversationSchema, sendMessageSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { requireWriteRole } from "../platform/authz";
import { cursorOf, idParam, parseQuery, type ConvDeps } from "../conversations/common";
import { encodeCursor, toConversationSummary, toMessageDto } from "../conversations/dto";
import { ConversationsRepository, MessagesRepository } from "../conversations/repos";

export function conversationRoutes({ cfg, db }: ConvDeps) {
  const r = new Hono<AppEnv>();
  // Scoped (not "*"): this router is mounted at /api/v1 next to other routers.
  r.use("/conversations", requireAuth(cfg));
  r.use("/conversations/*", requireAuth(cfg));
  // viewers are read-only (found by the role-matrix sweep: they could previously reply, take over, merge and edit)
  r.use("/conversations", requireWriteRole());
  r.use("/conversations/*", requireWriteRole());

  r.get("/conversations", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const q = parseQuery(c, listConversationsQuerySchema);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) =>
      new ConversationsRepository(tx, tenantId).list({
        status: q.status, handler: q.handler, channel: q.channel, contactId: q.contactId, q: q.q, cursor, limit: q.limit,
        assignedUserId: q.assignee === "me" ? userId : q.assignee === "unassigned" ? null : q.assignee,
      }));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({
      items: page.map(toConversationSummary),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs!, last.id) : null,
    });
  });

  r.get("/conversations/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, (tx) => new ConversationsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Conversation not found");
    return c.json(toConversationSummary(row));
  });

  r.get("/conversations/:id/messages", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const q = parseQuery(c, listMessagesQuerySchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      if (!(await new ConversationsRepository(tx, tenantId).get(id))) return null;
      return new MessagesRepository(tx, tenantId).page(id, { before: q.before, limit: q.limit, visitorOnly: false });
    });
    if (!out) throw Errors.notFound("Conversation not found");
    const page = out.slice(0, q.limit);
    return c.json({
      items: page.reverse().map(toMessageDto),
      nextCursor: out.length > q.limit ? page[0]!.id : null,
    });
  });

  r.post("/conversations/:id/messages", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const body = await parseBody(c, sendMessageSchema);
    const msg = await withTenant(db, tenantId, async (tx) => {
      const convs = new ConversationsRepository(tx, tenantId);
      const conv = await convs.get(id, true);
      if (!conv) return null;
      const messages = new MessagesRepository(tx, tenantId);
      if (body.kind === "reply") {
        // A human reply implies takeover: AI stops, conversation leaves the Needs Attention queue.
        await convs.setState(id, {
          status: "open", handler: "human",
          assignedUserId: conv.assignedUserId ?? userId,
        });
      }
      const { id: messageId } = await messages.insert({
        conversationId: id,
        senderType: body.kind === "note" ? "note" : "human",
        senderUserId: userId,
        content: body.text,
      });
      return messages.get(messageId);
    });
    if (!msg) throw Errors.notFound("Conversation not found");
    // Delivery: widget conversations are delivered by the realtime layer (DB trigger). External channel
    // adapters (Wave 3) will send from here.
    return c.json(toMessageDto(msg), 201);
  });

  r.post("/conversations/:id/takeover", async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, async (tx) => {
      const convs = new ConversationsRepository(tx, tenantId);
      const conv = await convs.get(id, true);
      if (!conv) return null;
      if (conv.assignedUserId && conv.assignedUserId !== userId && role === "agent") {
        throw Errors.conflict("Conversation is assigned to another agent");
      }
      await convs.setState(id, { status: "open", handler: "human", assignedUserId: userId });
      await new MessagesRepository(tx, tenantId).insert({
        conversationId: id, senderType: "system", senderUserId: userId, content: "Human agent took over", metadata: { event: "takeover" },
      });
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "conversation.takeover", resourceType: "conversation", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return convs.get(id);
    });
    if (!row) throw Errors.notFound("Conversation not found");
    return c.json(toConversationSummary(row));
  });

  r.post("/conversations/:id/return-to-ai", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, async (tx) => {
      const convs = new ConversationsRepository(tx, tenantId);
      const conv = await convs.get(id, true);
      if (!conv) return null;
      if (conv.contactBlockedAt) throw Errors.conflict("This contact is blocked for abuse. Unblock them before returning the conversation to the AI.");
      await convs.setState(id, { status: "open", handler: "ai", assignedUserId: null });
      // Without this the AI runtime stays paused (stage handoff_requested / ai_paused) and never answers again.
      await returnConversationToAi(tx, tenantId, id);
      await tx`UPDATE handoffs SET resolved_at = now(), resolved_by = ${userId}, resolution_note = 'returned to AI'
               WHERE tenant_id = ${tenantId} AND conversation_id = ${id} AND resolved_at IS NULL`;
      await new MessagesRepository(tx, tenantId).insert({
        conversationId: id, senderType: "system", senderUserId: userId, content: "Conversation returned to AI", metadata: { event: "returned_to_ai" },
      });
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "conversation.return_to_ai", resourceType: "conversation", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return convs.get(id);
    });
    if (!row) throw Errors.notFound("Conversation not found");
    return c.json(toConversationSummary(row));
  });

  r.patch("/conversations/:id", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const body = await parseBody(c, patchConversationSchema);
    const row = await withTenant(db, tenantId, async (tx) => {
      const convs = new ConversationsRepository(tx, tenantId);
      const conv = await convs.get(id, true);
      if (!conv) return null;
      if (body.assignedUserId) {
        const u = await new UsersRepository(tx, tenantId).findById(body.assignedUserId);
        if (!u || u.status !== "active") throw Errors.validation([{ path: "assignedUserId", message: "Unknown user" }]);
      }
      await convs.setState(id, {
        status: body.status,
        assignedUserId: body.assignedUserId,
        // assigning to a person means a human handles it; unassigning leaves the handler as is
        handler: body.assignedUserId ? "human" : undefined,
      });
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "conversation.update", resourceType: "conversation", resourceId: id,
        metadata: { ...body }, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return convs.get(id);
    });
    if (!row) throw Errors.notFound("Conversation not found");
    return c.json(toConversationSummary(row));
  });

  return r;
}
