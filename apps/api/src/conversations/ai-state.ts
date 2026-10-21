import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { requireAuth } from "../middleware";
import { idParam, type ConvDeps } from "./common";
import { ConversationsRepository } from "./repos";

const LEAD_KEYS = ["name", "email", "phone", "need", "budget", "timeline", "score", "summary"] as const;

/**
 * `GET /api/v1/conversations/:id/ai-state` -> `{ stage, lead, handoff }` (any authenticated role).
 * Stage + lead come from `conversation_ai_state`; `handoff` is the newest unresolved `handoffs` row (else null).
 * Tenant comes from the token only; foreign ids are 404.
 */
export function aiStateRoutes({ cfg, db }: ConvDeps) {
  const r = new Hono<AppEnv>();
  r.get("/conversations/:id/ai-state", requireAuth(cfg), async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const out = await withTenant(db, tenantId, async (tx) => {
      if (!(await new ConversationsRepository(tx, tenantId).get(id))) return null;
      const [st] = await tx<{ stage: string; lead: Record<string, unknown> | null }[]>`
        SELECT stage, lead FROM conversation_ai_state WHERE tenant_id = ${tenantId} AND conversation_id = ${id}`;
      const [h] = await tx<{ type: string; reason: string; leadCard: Record<string, unknown> | null }[]>`
        SELECT type, reason, lead_card FROM handoffs
        WHERE tenant_id = ${tenantId} AND conversation_id = ${id} AND resolved_at IS NULL
        ORDER BY created_at DESC LIMIT 1`;
      const src = { ...(h?.leadCard ?? {}), ...(st?.lead ?? {}) } as Record<string, unknown>;
      const lead: Record<string, unknown> = {};
      for (const k of LEAD_KEYS) if (src[k] !== undefined && src[k] !== null && src[k] !== "") lead[k] = src[k];
      return { stage: st?.stage ?? null, lead, handoff: h ? { type: h.type, reason: h.reason } : null };
    });
    if (!out) throw Errors.notFound("Conversation not found");
    return c.json(out);
  });
  return r;
}
