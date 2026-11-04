import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { VirusFoundError, scanUpload } from "@yulona/ai-runtime";
import { AuditLogRepository, withTenant } from "@yulona/db";
import { createWidgetSchema, updateWidgetSchema, type WidgetConfig, type WidgetDto } from "@yulona/shared";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { errorResponse, requireAuth } from "../middleware";
import { idParam, requireRoles, type ConvDeps } from "../conversations/common";
import { iso } from "../conversations/dto";
import { WidgetsRepository, type WidgetRow } from "../conversations/repos";
import type { Config } from "../config";
import { assertWithinLimit } from "../platform/limits";
import { sealTurnstileSecret } from "../conversations/turnstile";
import { MAX_AVATAR_BYTES, avatarEtag, sniffAvatarType } from "../conversations/avatar";

/** `primaryColor` stays the single-colour fallback for older widgets and is always derived from `appearance` when that is set. */
function withDerivedColor<T extends WidgetConfig | undefined>(config: T): T {
  if (!config?.appearance) return config;
  return { ...config, primaryColor: config.appearance.color } as T;
}

export const newWidgetKey = () => `wk_${randomBytes(18).toString("base64url")}`;

export function toWidgetDto(w: WidgetRow): WidgetDto {
  return {
    id: w.id, name: w.name, widgetKey: w.widgetKey, agentId: w.agentId, enabled: w.enabled,
    config: w.config ?? {}, prechat: w.prechat, allowedDomains: w.allowedDomains, hasTurnstileSecret: !!w.hasTurnstileSecret,
    hasAvatar: !!w.avatarVersion, avatarVersion: w.avatarVersion ?? null,
    createdAt: iso(w.createdAt)!, updatedAt: iso(w.updatedAt)!,
  };
}

const esc = (s: string) => s.replace(/[\\"<>&']/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function embedSnippet(cfg: Config, apiUrl: string, widgetKey: string): { snippet: string; scriptUrl: string } {
  const scriptUrl = cfg.widgetScriptUrl;
  const snippet = `<script>
  window.LumiConfig = { widgetKey: "${esc(widgetKey)}", apiUrl: "${esc(apiUrl)}" };
  (function (d, s) {
    var e = d.createElement("script");
    e.src = "${esc(scriptUrl)}"; e.async = true;
    d.head.appendChild(e);
  })(document);
</script>`;
  return { snippet, scriptUrl };
}

/** Turnstile can only be switched on with a site key and a stored secret (otherwise every visitor would be blocked). */
function assertTurnstileUsable(config: WidgetConfig | undefined, hasSecret: boolean): void {
  const t = config?.protection?.turnstile;
  if (!t?.enabled) return;
  if (!t.siteKey) throw Errors.validation([{ path: "config.protection.turnstile.siteKey", message: "Enter the Turnstile site key to enable it" }]);
  if (!hasSecret) throw Errors.validation([{ path: "turnstileSecret", message: "Enter the Turnstile secret key to enable it" }]);
}

export function widgetRoutes({ cfg, db }: ConvDeps) {
  const r = new Hono<AppEnv>();
  const needKey = () => {
    if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "ENCRYPTION_KEY is not configured");
    return cfg.encryptionKey;
  };
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
    const { turnstileSecret, ...parsed } = await parseBody(c, createWidgetSchema);
    const body = { ...parsed, config: withDerivedColor(parsed.config) };
    assertTurnstileUsable(body.config, !!turnstileSecret);
    const id = crypto.randomUUID();
    const turnstileSecretEnc = turnstileSecret ? sealTurnstileSecret(needKey(), tenantId, id, turnstileSecret) : null;
    const row = await withTenant(db, tenantId, async (tx) => {
      await assertWithinLimit(tx, tenantId, "widgets"); // plan limit (402)
      const w = await new WidgetsRepository(tx, tenantId).create({ ...body, id, widgetKey: newWidgetKey(), turnstileSecretEnc });
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
    const { turnstileSecret, ...parsed } = await parseBody(c, updateWidgetSchema);
    const body = parsed.config ? { ...parsed, config: withDerivedColor(parsed.config) } : parsed;
    const row = await withTenant(db, tenantId, async (tx) => {
      const repo = new WidgetsRepository(tx, tenantId);
      const cur = await repo.get(id);
      if (!cur) return undefined;
      assertTurnstileUsable(body.config ?? cur.config, turnstileSecret === undefined ? cur.hasTurnstileSecret : turnstileSecret !== null);
      const turnstileSecretEnc = turnstileSecret === undefined ? undefined : turnstileSecret === null ? null : sealTurnstileSecret(needKey(), tenantId, id, turnstileSecret);
      const w = await repo.update(id, { ...body, turnstileSecretEnc });
      if (w) await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "widget.update", resourceType: "widget", resourceId: id,
        metadata: { fields: Object.keys(body), turnstileSecret: turnstileSecret === undefined ? undefined : turnstileSecret === null ? "removed" : "rotated" },
        ip: c.get("ip"), requestId: c.get("requestId"),
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

  r.post("/widgets/:id/avatar", admin, bodyLimit({ maxSize: MAX_AVATAR_BYTES + 64 * 1024, onError: (c) => errorResponse(c, 413, "payload_too_large", "Image must be 512 KB or smaller") }), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    if (!/^multipart\/form-data/i.test(c.req.header("content-type") ?? "")) throw new AppError(415, "unsupported_media_type", "Content-Type must be multipart/form-data");
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new AppError(400, "validation_error", "Malformed multipart body");
    }
    const extra = Object.keys(form).filter((k) => k !== "file");
    if (extra.length) throw Errors.validation(extra.map((k) => ({ path: k, message: "Unknown field" })));
    const file = form.file;
    if (!(file instanceof File)) throw Errors.validation([{ path: "file", message: "A single image file is required" }]);
    if (file.size > MAX_AVATAR_BYTES) throw new AppError(413, "payload_too_large", "Image must be 512 KB or smaller");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = sniffAvatarType(bytes);
    if (!contentType) throw Errors.validation([{ path: "file", message: "Use a PNG, JPEG or WebP image" }]);
    try {
      await scanUpload(bytes);
    } catch (e) {
      if (e instanceof VirusFoundError) throw Errors.validation([{ path: "file", message: e.message }]);
      throw new AppError(503, "service_unavailable", "Upload scanning unavailable, try again later");
    }
    const etag = avatarEtag(bytes);
    const row = await withTenant(db, tenantId, async (tx) => {
      const repo = new WidgetsRepository(tx, tenantId);
      if (!(await repo.get(id))) return undefined;
      await repo.setAvatar(id, { contentType, data: bytes, etag, userId });
      await new AuditLogRepository(tx, tenantId).record({
        actorUserId: userId, action: "widget.avatar.upload", resourceType: "widget", resourceId: id,
        metadata: { contentType, sizeBytes: bytes.length }, ip: c.get("ip"), requestId: c.get("requestId"),
      });
      return repo.get(id);
    });
    if (!row) throw Errors.notFound("Widget not found");
    return c.json(toWidgetDto(row));
  });

  /** The dashboard previews the stored image through its own session (the public route is limited to the widget's allowed domains). */
  r.get("/widgets/:id/avatar", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const a = await withTenant(db, tenantId, (tx) => new WidgetsRepository(tx, tenantId).getAvatar(id));
    if (!a) throw Errors.notFound("No avatar");
    return c.body(a.data as never, 200, { "Content-Type": a.contentType, ETag: `"${a.etag}"`, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
  });

  r.delete("/widgets/:id/avatar", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, async (tx) => {
      const repo = new WidgetsRepository(tx, tenantId);
      if (!(await repo.get(id))) return undefined;
      if (await repo.removeAvatar(id)) await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "widget.avatar.remove", resourceType: "widget", resourceId: id, ip: c.get("ip"), requestId: c.get("requestId") });
      return repo.get(id);
    });
    if (!row) throw Errors.notFound("Widget not found");
    return c.json(toWidgetDto(row));
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
