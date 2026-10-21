import { Hono } from "hono";
import { createLlmResolver, portsFromResolver, type AiPorts } from "@yulona/ai-runtime";
import { withTenant, type Db } from "@yulona/db";
import { agentConfigSchema } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { guard } from "../ops/common";
import { assertWithinLimit } from "../platform/limits";
import { audit, parseId } from "../platform/util";
import type { RateLimiter } from "../ratelimit";
import { AgentsRepository } from "../routes/agents";
import { loadSession, runBuilderTurn, sessionDto, missingForFinish } from "./engine";
import { createAgentSchema, createSessionSchema, emptyDraft, sessionMessageSchema } from "./schemas";

export interface AgentBuilderDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  /** inject for tests; defaults to the LlmResolver (platform provider profile in SaaS, env otherwise) */
  ports?: AiPorts;
}

export const WELCOME = "Hi! I'll help you set up an AI agent for your business. To start, what does your business do, and who are your customers?";

export function agentBuilderRoutes({ cfg, db, limiter, ports: injected }: AgentBuilderDeps) {
  let resolved: AiPorts | undefined;
  const ports = () => injected ?? (resolved ??= portsFromResolver(createLlmResolver({ db, mode: cfg.deploymentMode, encryptionKey: cfg.encryptionKey })));
  const charge = cfg.deploymentMode !== "selfhosted";
  const r = new Hono<AppEnv>();
  const g = guard(cfg, "admin");

  r.post("/agent-builder/sessions", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    await parseBody(c, createSessionSchema);
    const lim = await limiter.hit(`builder-new:${tenantId}:${userId}`, 10, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const id = await withTenant(db, tenantId, async (tx) => {
      const [s] = await tx<{ id: string }[]>`INSERT INTO builder_sessions (tenant_id, user_id, draft) VALUES (${tenantId}, ${userId}, ${tx.json(emptyDraft() as never)}) RETURNING id`;
      await tx`INSERT INTO builder_messages (tenant_id, session_id, role, content) VALUES (${tenantId}, ${s!.id}, 'assistant', ${WELCOME})`;
      await audit(tx, c, "agent_builder.session_started", "builder_session", s!.id);
      return s!.id;
    });
    const out = await loadSession(db, tenantId, userId, id);
    return c.json(sessionDto(out!.session, out!.messages), 201);
  });

  r.get("/agent-builder/sessions/:id", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const out = await loadSession(db, tenantId, userId, parseId(c));
    if (!out) throw Errors.notFound("Session not found");
    return c.json(sessionDto(out.session, out.messages));
  });

  r.post("/agent-builder/sessions/:id/messages", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const lim = await limiter.hit(`builder:${tenantId}:${userId}`, 20, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const b = await parseBody(c, sessionMessageSchema);
    const out = await runBuilderTurn({ db, ports: ports(), charge, tenantId, userId, requestId: c.get("requestId"), ip: c.get("ip") }, id, b);
    return c.json(out);
  });

  r.post("/agent-builder/sessions/:id/create", g, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    await parseBody(c, createAgentSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const [s] = await tx<{ status: string; draft: ReturnType<typeof emptyDraft> }[]>`
        SELECT status, draft FROM builder_sessions WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND id = ${id} FOR UPDATE`;
      if (!s) throw Errors.notFound("Session not found");
      if (s.status !== "open") throw Errors.conflict("This session already created an agent or is closed");
      const draft = { ...emptyDraft(), ...s.draft };
      const missing = missingForFinish(draft);
      if (missing.length) throw Errors.validation(missing.map((path) => ({ path, message: "Required before creating the draft" })));
      const config = agentConfigSchema.safeParse(draft.config);
      if (!config.success) throw Errors.validation(config.error.issues.map((i) => ({ path: `config.${i.path.join(".")}`, message: i.message })));
      await assertWithinLimit(tx, tenantId, "agents");
      const agent = await new AgentsRepository(tx, tenantId).create({ name: draft.name!, description: draft.description ?? "", config: config.data, by: userId });
      await tx`UPDATE agents SET created_via = 'builder' WHERE tenant_id = ${tenantId} AND id = ${agent.id}`;
      await tx`UPDATE builder_sessions SET status = 'created', agent_id = ${agent.id}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${id}`;
      await audit(tx, c, "agent.created", "agent", agent.id, { name: agent.name, via: "builder", sessionId: id });
      return agent;
    });
    return c.json({
      agentId: out.id, name: out.name, status: out.status,
      sandboxHint: { path: `/agents/${out.id}`, tab: "sandbox", message: "Draft created. Try it in the sandbox tab, then publish when you are happy." },
    }, 201);
  });
  return r;
}
