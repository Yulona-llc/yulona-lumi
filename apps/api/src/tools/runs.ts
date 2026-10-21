import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseId } from "../platform/util";
import { guard, iso } from "../ops/common";
import type { ToolsDeps } from "./register";

interface Row { toolName: string; success: boolean; error: string | null; latencyMs: number; createdAt: Date }

/**
 * Recent tool runs of an agent (read-only, for the Tool activity panel). Only name, outcome, error text, latency and time:
 * never inputs or outputs. Runs belong to an agent through their conversation.
 */
export function toolRunRoutes({ cfg, db }: ToolsDeps) {
  const r = new Hono<AppEnv>();
  r.get("/agents/:id/tool-runs", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const raw = Number(c.req.query("limit") ?? 20);
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : 20;
    const rows = await withTenant(db, tenantId, async (tx) => {
      const [a] = await tx`SELECT 1 FROM agents WHERE tenant_id = ${tenantId} AND id = ${id}`;
      if (!a) return null;
      return tx<Row[]>`
        SELECT te.tool_name, te.success, te.error, te.latency_ms, te.created_at
        FROM tool_executions te JOIN conversations cv ON cv.id = te.conversation_id AND cv.tenant_id = te.tenant_id
        WHERE te.tenant_id = ${tenantId} AND cv.agent_id = ${id}
        ORDER BY te.created_at DESC, te.id DESC LIMIT ${limit}`;
    });
    if (!rows) throw Errors.notFound("Agent not found");
    return c.json({ items: rows.map((x) => ({ name: x.toolName, success: x.success, error: x.error, latencyMs: x.latencyMs, createdAt: iso(x.createdAt) })) });
  });
  return r;
}
