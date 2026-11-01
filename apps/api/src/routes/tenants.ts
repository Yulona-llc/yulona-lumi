// Tenant self-service (owner/admin): the current tenant and its plan limits. Platform administration lives in apps/admin-api.
import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { LIMIT_METRICS, checkLimit } from "../platform/limits";
import { requireMinRole } from "../platform/authz";
import { audit } from "../platform/util";

// ------------------------------------------------------------------ tenant self-service
export function tenantRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.use("/tenant/*", requireAuth(cfg));

  r.get("/tenant", async (c) => {
    const { tenantId } = c.get("auth");
    const out = await withTenant(db, tenantId, async (tx) => {
      const [t] = await tx<{ id: string; name: string; status: string; planKey: string; planName: string }[]>`
        SELECT t.id, t.name, t.status, t.plan_key, p.name AS plan_name FROM tenants t JOIN plans p ON p.key = t.plan_key WHERE t.id = ${tenantId}`;
      const limits = await Promise.all(LIMIT_METRICS.map((m) => checkLimit(tx, tenantId, m)));
      return { t, limits };
    });
    if (!out.t) throw Errors.notFound();
    return c.json({
      id: out.t.id, name: out.t.name, status: out.t.status, plan: { key: out.t.planKey, name: out.t.planName },
      limits: out.limits.map((l) => ({ metric: l.metric, limit: l.limit, used: l.used, warning: l.warning })),
    });
  });

  r.patch("/tenant", requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const body = await parseBody(c, z.strictObject({ name: z.string().trim().min(1).max(100) }));
    await withTenant(db, tenantId, async (tx) => {
      await tx`UPDATE tenants SET name = ${body.name}, updated_at = now() WHERE id = ${tenantId}`;
      await audit(tx, c, "tenant.renamed", "tenant", tenantId, { name: body.name });
    });
    return c.json({ id: tenantId, name: body.name });
  });
  return r;
}
