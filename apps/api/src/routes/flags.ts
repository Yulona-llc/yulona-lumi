import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Db, type Tx } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";

/** Effective flag value for a tenant: override if present, else the flag's default. Unknown flag => false. */
export async function isFeatureEnabled(tx: Tx, tenantId: string, key: string): Promise<boolean> {
  const [r] = await tx<{ enabled: boolean }[]>`
    SELECT COALESCE(o.enabled, f.default_enabled) AS enabled FROM feature_flags f
    LEFT JOIN tenant_flag_overrides o ON o.flag_key = f.key AND o.tenant_id = ${tenantId}
    WHERE f.key = ${key}`;
  return r?.enabled ?? false;
}

export const flagKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);

export function flagRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.use("/feature-flags/*", requireAuth(cfg));
  /** Effective flags for the caller's tenant: { flags: { key: boolean } } */
  r.get("/feature-flags", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => tx<{ key: string; enabled: boolean }[]>`
      SELECT f.key, COALESCE(o.enabled, f.default_enabled) AS enabled FROM feature_flags f
      LEFT JOIN tenant_flag_overrides o ON o.flag_key = f.key AND o.tenant_id = ${tenantId} ORDER BY f.key`);
    return c.json({ flags: Object.fromEntries(rows.map((x) => [x.key, x.enabled])) });
  });
  return r;
}
