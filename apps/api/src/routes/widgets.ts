import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { AuditLogRepository, withTenant } from "@yulona/db";
import { createWidgetSchema, updateWidgetSchema, type WidgetDto } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { idParam, requireRoles, type ConvDeps } from "../conversations/common";
import { iso } from "../conversations/dto";
import { WidgetsRepository, type WidgetRow } from "../conversations/repos";
import type { Config } from "../config";
import { assertWithinLimit } from "../platform/limits";

export const newWidgetKey = () => `wk_${randomBytes(18).toString("base64url")}`;

export function toWidgetDto(w: WidgetRow): WidgetDto {
  return {
    id: w.id, name: w.name, widgetKey: w.widgetKey, agentId: w.agentId, enabled: w.enabled,
    config: w.config ?? {}, prechat: w.prechat, allowedDomains: w.allowedDomains,
    createdAt: iso(w.createdAt)!, updatedAt: iso(w.updatedAt)!,
  };
}

const esc = (s: string) => s.replace(/[\\"<>&']/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function embedSnippet(cfg: Config, apiUrl: string, widgetKey: string): { snippet: string; scriptUrl: string } {
  const scriptUrl = cfg.widgetScriptUrl;
  const snippet = `<script>
  window.YulonaConfig = { widgetKey: "${esc(widgetKey)}", apiUrl: "${esc(apiUrl)}" };
  (function (d, s) {
    var e = d.createElement("script");
    e.src = "${esc(scriptUrl)}"; e.async = true;
    d.head.appendChild(e);
  })(document);
</script>`;
  return { snippet, scriptUrl };
}

export function widgetRoutes({ cfg, db }: ConvDeps) {
  const r = new Hono<AppEnv>();
  r.use("/widgets", requireAuth(cfg));
  r.use("/widgets/*", requireAuth(cfg));
  const admin = requireRoles("owner", "admin");

  r.get("/widgets", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new WidgetsRepository(tx, tenantId).list());
    return c.json({ items: rows.map(toWidgetDto) });
  });

  r.post("/widgets", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const body = await parseBody(c, createWidgetSchema);
    const row = await withTenant(db, tenantId, async (tx) => {
      await assertWithinLimit(tx, tenantId, "widgets"); // plan limit (402)
      const w = await new WidgetsRepository(tx, tenantId).create({ ...body, widgetKey: newWidgetKey() });
      await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "widget.create", resourceType: "widget", resourceId: w.id, ip: c.get("ip"), requestId: c.get("requestId") });
      return w;
    });
    return c.json(toWidgetDto(row), 201);
  });

  r.get("/widgets/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, (tx) => new WidgetsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Widget not found");
    return c.json(toWidgetDto(row));
  });

  r.patch("/widgets/:id", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const body = await parseBody(c, updateWidgetSchema);
    const row = await withTenant(db, tenantId, async (tx) => {
      const w = await new WidgetsRepository(tx, tenantId).update(id, body);
      if (w) await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "widget.update", resourceType: "widget", resourceId: id,
        metadata: { fields: Object.keys(body) }, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return w;
    });
    if (!row) throw Errors.notFound("Widget not found");
    return c.json(toWidgetDto(row));
  });

  r.delete("/widgets/:id", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const deleted = await new WidgetsRepository(tx, tenantId).delete(id);
      if (deleted) await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "widget.delete", resourceType: "widget", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId") });
      return deleted;
    });
    if (!ok) throw Errors.notFound("Widget not found");
    return c.json({ ok: true as const });
  });

  r.post("/widgets/:id/rotate-key", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, async (tx) => {
      const w = await new WidgetsRepository(tx, tenantId).rotateKey(id, newWidgetKey());
      if (w) await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "widget.rotate_key", resourceType: "widget", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId") });
      return w;
    });
    if (!row) throw Errors.notFound("Widget not found");
    return c.json(toWidgetDto(row));
  });

  r.get("/widgets/:id/embed", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, (tx) => new WidgetsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Widget not found");
    const apiUrl = cfg.publicApiUrl ?? new URL(c.req.url).origin;
    return c.json({ ...embedSnippet(cfg, apiUrl, row.widgetKey), widgetKey: row.widgetKey, apiUrl });
  });

  return r;
}
