import { Hono } from "hono";
import { TenantsRepository, UsersRepository, withTenant, type Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { requireAuth } from "../middleware";

export function meRoutes(cfg: Config, db: Db) {
  const r = new Hono<AppEnv>();
  r.use("/me", requireAuth(cfg));
  r.get("/me", async (c) => {
    const { tenantId, userId, impersonatorId, impersonationSessionId: sessionId, readOnly } = c.get("auth");
    const found = await withTenant(db, tenantId, async (tx) => ({
      user: await new UsersRepository(tx, tenantId).findById(userId),
      tenant: await new TenantsRepository(tx, tenantId).get(),
    }));
    if (!found.user || !found.tenant || found.user.status !== "active") throw Errors.unauthorized();
    return c.json({
      user: { id: found.user.id, email: found.user.email, name: found.user.name, role: found.user.role },
      tenant: { id: found.tenant.id, name: found.tenant.name },
      impersonation: impersonatorId ? { active: true as const, impersonatorId, sessionId: sessionId ?? null, readOnly: readOnly ?? false } : null,
    });
  });
  return r;
}
