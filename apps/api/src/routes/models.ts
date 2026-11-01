import { Hono } from "hono";
import type { Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";

/**
 * Models an agent can be set to. SaaS: the platform's enabled models (llm_model_rates, the catalogue the platform admin manages;
 * the wildcard `*` rate is only a price fallback and is not a model). Self-hosted: the operator's own provider decides, so the list is
 * empty and the dashboard shows a free-text field.
 */
export function modelRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.get("/models", requireAuth(cfg), async (c) => {
    if (cfg.deploymentMode === "selfhosted") return c.json({ mode: "selfhosted" as const, models: [] as string[] });
    const rows = await db<{ model: string }[]>`SELECT model FROM llm_model_rates WHERE enabled AND model <> '*' ORDER BY model`;
    return c.json({ mode: "saas" as const, models: rows.map((x) => x.model) });
  });
  return r;
}
