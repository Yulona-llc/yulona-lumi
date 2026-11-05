import { randomBytes, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { AuditLogRepository, withTenant } from "@yulona/db";
import type { ChannelAdapter, ChannelRegistry, ChannelCredentials } from "@yulona/channels";
import { credentialAad } from "@yulona/channels";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { enforceLimit, requireAuth } from "../middleware";
import { idParam, requireRoles, type ConvDeps } from "../conversations/common";
import { decryptCredentials, encryptCredentials } from "../conversations/crypto";
import { iso } from "../conversations/dto";
import { ConnectionsRepository, MergeSuggestionsRepository, type ConnectionRow } from "./repos";
import { CONNECTABLE_CHANNELS, createConnectionSchema, updateConnectionSchema, type ConnectionDto } from "./schemas";

/** Webhook secrets the server can mint when the tenant does not supply one. */
const GENERATED = ["verifyToken", "webhookSecret"] as const;
/** Credential fields that double as the channel-side account identifier. */
const EXTERNAL_ID_FIELDS = ["phoneNumberId", "pageId", "igUserId"] as const;

const mask = (v: string) => (v.length > 8 ? `••••${v.slice(-4)}` : "••••");

export interface ChannelRouteDeps extends Omit<ConvDeps, "realtime"> {
  registry: ChannelRegistry;
}

export const webhookUrlFor = (cfg: ConvDeps["cfg"], origin: string, channel: string, id: string) =>
  `${cfg.publicApiUrl ?? origin}/api/v1/webhooks/channels/${channel}/${id}`;

export function channelRoutes({ cfg, db, limiter, registry }: ChannelRouteDeps) {
  const r = new Hono<AppEnv>();
  r.use("/channels", requireAuth(cfg));
  r.use("/channels/*", requireAuth(cfg));
  const admin = requireRoles("owner", "admin");

  function key(): string {
    if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "ENCRYPTION_KEY is not configured; channel credentials cannot be stored");
    return cfg.encryptionKey;
  }
  const adapterFor = (channel: string): ChannelAdapter => {
    const a = registry.get(channel as never);
    if (!a || !(CONNECTABLE_CHANNELS as readonly string[]).includes(channel)) throw Errors.validation([{ path: "channel", message: "Unsupported channel" }]);
    return a;
  };

  /** Validate field names against the adapter; unknown credential keys are rejected. */
  function checkCredentials(adapter: ChannelAdapter, creds: Record<string, string>) {
    const fields = adapter.credentialFields ?? [];
    const known = new Set(fields.map((f) => f.name));
    const issues: { path: string; message: string }[] = [];
    for (const k of Object.keys(creds)) if (!known.has(k)) issues.push({ path: `credentials.${k}`, message: "Unknown credential field" });
    for (const f of fields) if (f.required && !creds[f.name]) issues.push({ path: `credentials.${f.name}`, message: "Required" });
    if (issues.length) throw Errors.validation(issues);
  }

  function toDto(row: ConnectionRow, origin: string, tenantId: string): ConnectionDto {
    const adapter = registry.get(row.channel);
    let creds: ChannelCredentials = {};
    try {
      creds = decryptCredentials(key(), row.credentialsEncrypted, credentialAad(tenantId, row.id));
    } catch {
      /* unreadable credentials (key rotated?) are shown as empty; health check will flag it */
    }
    const masked: Record<string, string> = {};
    for (const f of adapter?.credentialFields ?? []) {
      const v = creds[f.name];
      if (v) masked[f.name] = f.secret ? mask(v) : v;
    }
    return {
      id: row.id, channel: row.channel, name: row.name, externalId: row.externalId, agentId: row.agentId, status: row.status,
      credentialsMasked: masked, webhookUrl: webhookUrlFor(cfg, origin, row.channel, row.id),
      health: { checkedAt: iso(row.lastHealthAt), ok: row.lastHealthOk, error: row.lastHealthError },
      createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
    };
  }
  const dto = (c: Context<AppEnv>, row: ConnectionRow) => toDto(row, new URL(c.req.url).origin, c.get("auth").tenantId);

  const audit = (c: Context<AppEnv>, tx: Parameters<Parameters<typeof withTenant>[2]>[0], action: string, id: string, metadata?: Record<string, unknown>) =>
    new AuditLogRepository(tx, c.get("auth").tenantId).record({
      actorUserId: c.get("auth").userId, action, resourceType: "channel_connection", resourceId: id, metadata,
      ip: c.get("ip"), requestId: c.get("requestId"),
    });

  r.get("/channels/available", (c) =>
    c.json({
      items: CONNECTABLE_CHANNELS.map((ch) => {
        const a = registry.require(ch);
        return { channel: ch, capabilities: a.capabilities, credentialFields: a.credentialFields ?? [] };
      }),
    }));

  r.get("/channels/connections", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new ConnectionsRepository(tx, tenantId).list());
    return c.json({ items: rows.map((row) => dto(c, row)) });
  });

  r.post("/channels/connections", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const body = await parseBody(c, createConnectionSchema);
    const adapter = adapterFor(body.channel);
    const encKey = key();
    const credentials: Record<string, string> = { ...body.credentials };
    const generated: Record<string, string> = {};
    for (const g of GENERATED) {
      if (adapter.credentialFields?.some((f) => f.name === g) && !credentials[g]) generated[g] = credentials[g] = randomBytes(24).toString("base64url");
    }
    checkCredentials(adapter, credentials);
    const id = randomUUID();
    const externalId = EXTERNAL_ID_FIELDS.map((f) => credentials[f]).find(Boolean) ?? null;
    const row = await withTenant(db, tenantId, async (tx) => {
      const repo = new ConnectionsRepository(tx, tenantId);
      if (body.agentId && !(await repo.agentExists(body.agentId))) throw Errors.validation([{ path: "agentId", message: "Unknown agent" }]);
      const created = await repo.create({
        id, channel: body.channel, name: body.name, externalId, agentId: body.agentId ?? null,
        credentialsEncrypted: encryptCredentials(encKey, credentials, credentialAad(tenantId, id)),
      });
      await audit(c, tx, "channel_connection.create", id, { channel: body.channel });
      return created;
    });
    return c.json({ ...dto(c, row), generatedSecrets: generated }, 201);
  });

  r.get("/channels/connections/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const row = await withTenant(db, tenantId, (tx) => new ConnectionsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Connection not found");
    return c.json(dto(c, row));
  });

  r.patch("/channels/connections/:id", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const body = await parseBody(c, updateConnectionSchema);
    const row = await withTenant(db, tenantId, async (tx) => {
      const repo = new ConnectionsRepository(tx, tenantId);
      const cur = await repo.get(id, true);
      if (!cur) return undefined;
      if (body.agentId && !(await repo.agentExists(body.agentId))) throw Errors.validation([{ path: "agentId", message: "Unknown agent" }]);
      let credentialsEncrypted: string | undefined;
      let externalId: string | null | undefined;
      if (body.credentials) {
        const adapter = adapterFor(cur.channel);
        const merged = { ...decryptCredentials(key(), cur.credentialsEncrypted, credentialAad(tenantId, id)), ...body.credentials };
        checkCredentials(adapter, merged);
        credentialsEncrypted = encryptCredentials(key(), merged, credentialAad(tenantId, id));
        externalId = EXTERNAL_ID_FIELDS.map((f) => merged[f]).find(Boolean) ?? null;
      }
      await repo.update(id, { name: body.name, agentId: body.agentId, status: body.status, credentialsEncrypted, externalId });
      await audit(c, tx, "channel_connection.update", id, { fields: Object.keys(body) });
      return repo.get(id);
    });
    if (!row) throw Errors.notFound("Connection not found");
    return c.json(dto(c, row));
  });

  r.delete("/channels/connections/:id", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const del = await new ConnectionsRepository(tx, tenantId).delete(id);
      if (del) await audit(c, tx, "channel_connection.delete", id);
      return del;
    });
    if (!ok) throw Errors.notFound("Connection not found");
    return c.json({ ok: true as const });
  });

  /** Live health check: calls the provider with the stored credentials and records the outcome. */
  r.post("/channels/connections/:id/test", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    await enforceLimit(limiter, `ch:test:${tenantId}`, { limit: 20, windowMs: 60_000 });
    const row = await withTenant(db, tenantId, (tx) => new ConnectionsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Connection not found");
    const adapter = adapterFor(row.channel);
    let result: { ok: boolean; detail?: string };
    try {
      const creds = decryptCredentials(key(), row.credentialsEncrypted, credentialAad(tenantId, id));
      result = adapter.checkHealth ? await adapter.checkHealth(creds) : { ok: true, detail: "no health check available" };
    } catch (e) {
      result = { ok: false, detail: e instanceof AppError ? e.message : "credentials cannot be decrypted" };
    }
    await withTenant(db, tenantId, async (tx) => {
      await new ConnectionsRepository(tx, tenantId).recordHealth(id, result.ok, result.ok ? null : (result.detail ?? "failed").slice(0, 300));
      await audit(c, tx, "channel_connection.test", id, { ok: result.ok });
    });
    return c.json({ ok: result.ok, detail: result.detail ?? null, checkedAt: new Date().toISOString() });
  });

  /** Register our webhook URL with the provider using the stored credentials (Telegram: `setWebhook`), so nobody has to call it by hand. */
  r.post("/channels/connections/:id/register-webhook", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    await enforceLimit(limiter, `ch:webhook:${tenantId}`, { limit: 10, windowMs: 60_000 });
    const row = await withTenant(db, tenantId, (tx) => new ConnectionsRepository(tx, tenantId).get(id));
    if (!row) throw Errors.notFound("Connection not found");
    const adapter = adapterFor(row.channel);
    if (!adapter.registerWebhook) throw Errors.validation([{ path: "channel", message: "This channel is set up in the provider's own console" }]);
    const webhookUrl = webhookUrlFor(cfg, new URL(c.req.url).origin, row.channel, id);
    let result: { ok: boolean; detail?: string };
    if (!webhookUrl.startsWith("https://")) result = { ok: false, detail: "Telegram only accepts https webhook URLs. Set PUBLIC_API_URL to your https API address and try again." };
    else {
      try {
        result = await adapter.registerWebhook(decryptCredentials(key(), row.credentialsEncrypted, credentialAad(tenantId, id)), webhookUrl);
      } catch (e) {
        result = { ok: false, detail: e instanceof AppError ? e.message : "credentials cannot be decrypted" };
      }
    }
    await withTenant(db, tenantId, (tx) => audit(c, tx, "channel_connection.register_webhook", id, { ok: result.ok }));
    return c.json({ ok: result.ok, detail: result.detail ?? null, webhookUrl });
  });

  // ---- cross-channel identity: merge suggestions (confirm via POST /contacts/:id/merge)
  r.get("/channels/merge-suggestions", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new MergeSuggestionsRepository(tx, tenantId).list(100));
    return c.json({
      items: rows.map((s) => ({
        id: s.id, reason: s.reason, createdAt: iso(s.createdAt)!,
        primary: { id: s.pId, name: s.pName, email: s.pEmail, phone: s.pPhone },
        other: { id: s.oId, name: s.oName, email: s.oEmail, phone: s.oPhone },
      })),
    });
  });
  r.post("/channels/merge-suggestions/:id/dismiss", requireRoles("owner", "admin", "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const ok = await withTenant(db, tenantId, (tx) => new MergeSuggestionsRepository(tx, tenantId).dismiss(id));
    if (!ok) throw Errors.notFound("Suggestion not found");
    return c.json({ ok: true as const });
  });

  return r;
}
