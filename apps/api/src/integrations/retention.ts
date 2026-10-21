import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Tx } from "@yulona/db";
import { requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { audit } from "../platform/util";
import { parseBody } from "../http";
import type { AppEnv } from "../context";
import { iso, type IntegrationsDeps } from "./common";

const days = (min: number, max: number) => z.number().int().min(min).max(max).nullable();
export const putRetentionSchema = z.strictObject({
  messagesDays: days(7, 3650),
  auditLogsDays: days(30, 3650),
  webhookLogsDays: days(1, 365),
  toolLogsDays: days(7, 3650),
});

interface Row { messagesDays: number | null; auditLogsDays: number | null; webhookLogsDays: number | null; toolLogsDays: number | null; updatedAt: Date }
const read = async (tx: Tx, tenantId: string) => {
  const [r] = await tx<Row[]>`SELECT messages_days, audit_logs_days, webhook_logs_days, tool_logs_days, updated_at FROM retention_policies WHERE tenant_id = ${tenantId}`;
  return r;
};
const dto = (r: Row | undefined) => ({
  messagesDays: r?.messagesDays ?? null, auditLogsDays: r?.auditLogsDays ?? null,
  webhookLogsDays: r?.webhookLogsDays ?? null, toolLogsDays: r?.toolLogsDays ?? null,
  updatedAt: iso(r?.updatedAt),
  /** applied when a field is null */
  defaults: { messagesDays: null, auditLogsDays: null, webhookLogsDays: 30, toolLogsDays: null },
});

export function retentionRoutes({ cfg, db }: IntegrationsDeps) {
  const r = new Hono<AppEnv>();
  r.use("/retention", requireAuth(cfg), requireMinRole("admin"));

  r.get("/retention", async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(dto(await withTenant(db, tenantId, (tx) => read(tx, tenantId))));
  });

  r.put("/retention", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, putRetentionSchema);
    const row = await withTenant(db, tenantId, async (tx) => {
      await tx`INSERT INTO retention_policies (tenant_id, messages_days, audit_logs_days, webhook_logs_days, tool_logs_days, updated_by)
        VALUES (${tenantId}, ${b.messagesDays}, ${b.auditLogsDays}, ${b.webhookLogsDays}, ${b.toolLogsDays}, ${userId})
        ON CONFLICT (tenant_id) DO UPDATE SET messages_days = EXCLUDED.messages_days, audit_logs_days = EXCLUDED.audit_logs_days,
          webhook_logs_days = EXCLUDED.webhook_logs_days, tool_logs_days = EXCLUDED.tool_logs_days, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await audit(tx, c, "retention.updated", "retention_policy", tenantId, b);
      return read(tx, tenantId);
    });
    return c.json(dto(row));
  });

  return r;
}
