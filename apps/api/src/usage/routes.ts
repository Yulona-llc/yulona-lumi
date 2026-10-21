// Tenant-facing AI usage + credits. Always mounted (any deployment mode); billing/top-ups live in the SaaS billing router.
import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { toCsv } from "../billing/csv";
import { Errors } from "../errors";
import { requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { parseQuery } from "../platform/util";
import { loadCredits } from "./credits";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Invalid date");
export const usageAiQuery = z.strictObject({
  from: isoDay.optional(),
  to: isoDay.optional(),
  groupBy: z.enum(["day", "agent", "model", "conversation"]).default("day"),
});

interface Item { key: string | null; label: string | null; promptTokens: string; completionTokens: string; requests: string; creditsMicro: string }
const num = (v: string | number | null | undefined) => Number(v ?? 0);
const dto = (i: Item, groupBy: string) => {
  const promptTokens = num(i.promptTokens), completionTokens = num(i.completionTokens);
  const key = i.key ?? "";
  const label = groupBy === "day" ? key
    : groupBy === "agent" ? (i.key === null ? "(unattributed)" : i.label ?? "(deleted agent)")
    : groupBy === "model" ? (i.key ?? "(unknown)")
    : (i.key === null ? "(no conversation)" : key);
  return { key, label, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, requests: num(i.requests), creditsMicro: num(i.creditsMicro) };
};

export function usageRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(cfg);

  async function report(tenantId: string, q: z.output<typeof usageAiQuery>) {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span < 0 || span > 365) throw Errors.validation([{ path: "from", message: "Range must be 0-366 days and from <= to" }]);
    const { items, totals } = await withTenant(db, tenantId, async (tx) => {
      const agg = tx`sum(e.prompt_tokens)::bigint AS prompt_tokens, sum(e.completion_tokens)::bigint AS completion_tokens, count(*)::bigint AS requests, sum(e.credits_micro)::bigint AS credits_micro`;
      const where = tx`e.tenant_id = ${tenantId} AND e.day BETWEEN ${from}::date AND ${to}::date`;
      let rows: Item[];
      if (q.groupBy === "day") {
        rows = await tx<Item[]>`SELECT to_char(e.day, 'YYYY-MM-DD') AS key, NULL::text AS label, ${agg} FROM ai_usage_events e WHERE ${where} GROUP BY e.day ORDER BY e.day`;
      } else if (q.groupBy === "agent") {
        rows = await tx<Item[]>`
          SELECT e.agent_id::text AS key, max(a.name) AS label, ${agg} FROM ai_usage_events e
          LEFT JOIN agents a ON a.tenant_id = e.tenant_id AND a.id = e.agent_id
          WHERE ${where} GROUP BY e.agent_id ORDER BY sum(e.credits_micro) DESC, e.agent_id`;
      } else if (q.groupBy === "model") {
        rows = await tx<Item[]>`SELECT e.model AS key, e.model AS label, ${agg} FROM ai_usage_events e WHERE ${where} GROUP BY e.model ORDER BY sum(e.credits_micro) DESC, e.model`;
      } else {
        rows = await tx<Item[]>`
          SELECT e.conversation_id::text AS key, NULL::text AS label, ${agg} FROM ai_usage_events e
          WHERE ${where} GROUP BY e.conversation_id ORDER BY sum(e.credits_micro) DESC, e.conversation_id LIMIT 200`;
      }
      const [t] = await tx<Omit<Item, "key" | "label">[]>`SELECT ${agg} FROM ai_usage_events e WHERE ${where}`;
      return { items: rows, totals: t! };
    });
    const tp = num(totals.promptTokens), tc = num(totals.completionTokens);
    return {
      from, to, groupBy: q.groupBy, items: items.map((i) => dto(i, q.groupBy)),
      totals: { promptTokens: tp, completionTokens: tc, totalTokens: tp + tc, requests: num(totals.requests), creditsMicro: num(totals.creditsMicro) },
    };
  }

  r.get("/usage/credits", auth, async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(await withTenant(db, tenantId, (tx) => loadCredits(tx, tenantId, cfg.deploymentMode)));
  });

  r.get("/usage/ai", auth, requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(await report(tenantId, parseQuery(c, usageAiQuery)));
  });

  r.get("/usage/ai/export", auth, requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const out = await report(tenantId, parseQuery(c, usageAiQuery));
    const csv = toCsv(
      ["key", "label", "promptTokens", "completionTokens", "totalTokens", "requests", "creditsMicro"],
      out.items.map((i) => [i.key, i.label, i.promptTokens, i.completionTokens, i.totalTokens, i.requests, i.creditsMicro]),
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="ai-usage-${out.groupBy}-${out.from}-${out.to}.csv"`,
      },
    });
  });

  return r;
}
