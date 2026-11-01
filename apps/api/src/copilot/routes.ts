import { Hono } from "hono";
import { withTenant, type Db } from "@yulona/db";
import { copilotMessageSchema, copilotTokenSchema } from "@yulona/shared";
import type { AiPorts } from "@yulona/ai-runtime";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { guard } from "../ops/common";
import { audit, parseId } from "../platform/util";
import type { RateLimiter } from "../ratelimit";
import { MAX_USER_MESSAGES, assertCopilotAllowed, copilotStatus } from "./access";
import { WELCOME, WELCOME_CHIPS, copilotSessionDto, loadCopilotSession, resolvePending, runCopilotTurn } from "./engine";

export interface CopilotDeps { cfg: Config; db: Db; limiter: RateLimiter; ports: () => AiPorts }

export function copilotRoutes({ cfg, db, limiter, ports }: CopilotDeps) {
  const r = new Hono<AppEnv>();
  const g = guard(cfg, "admin");
  const mode = cfg.deploymentMode;

  r.get("/copilot/status", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    return c.json(await withTenant(db, tenantId, (tx) => copilotStatus(tx, tenantId, userId, mode)));
  });

  r.post("/copilot/sessions", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const lim = await limiter.hit(`copilot-new:${tenantId}:${userId}`, 10, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const id = await withTenant(db, tenantId, async (tx) => {
      await assertCopilotAllowed(tx, tenantId, mode);
      await tx`UPDATE copilot_sessions SET status = 'closed' WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND status = 'open'`;
      const [s] = await tx<{ id: string }[]>`INSERT INTO copilot_sessions (tenant_id, user_id) VALUES (${tenantId}, ${userId}) RETURNING id`;
      await tx`INSERT INTO copilot_messages (tenant_id, session_id, role, content, payload) VALUES (${tenantId}, ${s!.id}, 'assistant', ${WELCOME}, ${tx.json({ blocks: [{ type: "chips", options: WELCOME_CHIPS }] } as never)})`;
      await audit(tx, c, "copilot.session_started", "copilot_session", s!.id);
      return s!.id;
    });
    const out = (await loadCopilotSession(db, tenantId, userId, id))!;
    return c.json(copilotSessionDto(out.session, out.messages), 201);
  });

  r.get("/copilot/sessions/:id", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const out = await loadCopilotSession(db, tenantId, userId, parseId(c));
    if (!out) throw Errors.notFound("Session not found");
    return c.json(copilotSessionDto(out.session, out.messages));
  });

  r.post("/copilot/sessions/:id/messages", g, async (c) => {
    const { tenantId, userId, role } = c.get("auth");
    const id = parseId(c);
    const lim = await limiter.hit(`copilot:${tenantId}:${userId}`, 20, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const b = await parseBody(c, copilotMessageSchema);
    const out = await runCopilotTurn({ db, ports: ports(), mode, model: cfg.copilotModel, tenantId, userId, role, requestId: c.get("requestId"), ip: c.get("ip") }, id, b);
    return c.json({ ...out, limits: { maxUserMessages: MAX_USER_MESSAGES } });
  });

  for (const action of ["confirm", "cancel"] as const) {
    r.post(`/copilot/sessions/:id/${action}`, g, async (c) => {
      const { tenantId, userId } = c.get("auth");
      const id = parseId(c);
      const lim = await limiter.hit(`copilot-act:${tenantId}:${userId}`, 20, 60_000);
      if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
      const b = await parseBody(c, copilotTokenSchema);
      return c.json(await resolvePending({ db, tenantId, userId, sessionId: id, requestId: c.get("requestId"), ip: c.get("ip") }, b.token, action));
    });
  }
  return r;
}
