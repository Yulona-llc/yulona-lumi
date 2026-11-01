import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { buildHubSpotProperties, crmErrorText, HubSpotClient, HubSpotError, openHubspotToken, parseHubspotMapping, sealHubspotToken } from "@yulona/ops";
import { connectHubspotSchema, hubspotTestContactSchema, updateHubspotMappingSchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { audit } from "../platform/util";
import { guard, iso, type OpsDeps } from "./common";

interface ConnRow { tokenEncrypted: string; status: string; lastError: string | null; settings: unknown; lastSyncAt: Date | null; createdAt: Date }

/** HubSpot CRM integration (private-app token). Owner/admin only; the token is write-only and never returned or logged (docs/api/ops.md "HubSpot"). */
export function hubspotRoutes(deps: OpsDeps) {
  const { cfg, db, runtime, limiter } = deps;
  const r = new Hono<AppEnv>();
  const client = (token: string) => new HubSpotClient(token, { fetchImpl: runtime.fetchImpl, apiBase: runtime.hubspot?.apiBase, retry: runtime.hubspot?.retry });
  const needKey = () => { if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "HubSpot needs ENCRYPTION_KEY to store the token"); return cfg.encryptionKey; };

  r.get("/crm/hubspot", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    return withTenant(db, tenantId, async (tx) => {
      const [x] = await tx<ConnRow[]>`SELECT token_encrypted, status, last_error, settings, last_sync_at, created_at FROM crm_connections WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
      const recent = x ? await tx<{ id: string; trigger: string; status: string; action: string | null; hubspotId: string | null; error: string | null; conversationId: string | null; createdAt: Date; syncedAt: Date | null }[]>`
        SELECT id, trigger, status, action, hubspot_id, error, conversation_id, created_at, synced_at FROM crm_sync_log
        WHERE tenant_id = ${tenantId} AND provider = 'hubspot' ORDER BY created_at DESC LIMIT 10` : [];
      return c.json({
        configured: !!cfg.encryptionKey, connected: !!x, status: x?.status ?? null, lastError: x?.lastError ?? null, lastSyncAt: iso(x?.lastSyncAt),
        connectedAt: iso(x?.createdAt), mapping: x ? parseHubspotMapping(x.settings) : parseHubspotMapping({}),
        recent: recent.map((l) => ({ ...l, createdAt: iso(l.createdAt), syncedAt: iso(l.syncedAt) })),
      });
    });
  });

  /** Save (or replace) the token after a live test call, so a wrong token or missing scope is rejected immediately. */
  r.put("/crm/hubspot/connection", guard(cfg, "admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const key = needKey();
    const b = await parseBody(c, connectHubspotSchema);
    try {
      await client(b.token).testConnection();
    } catch (e) {
      deps.log.warn("hubspot connect test failed", { tenantId, status: (e as { status?: number }).status });
      if (e instanceof HubSpotError && (e.authFailure || e.status === 400)) throw Errors.validation([{ path: "token", message: crmErrorText(e) }]);
      throw new AppError(503, "service_unavailable", "HubSpot is temporarily unavailable. Try again.");
    }
    const sealed = sealHubspotToken(key, tenantId, b.token);
    await withTenant(db, tenantId, async (tx) => {
      const settings = b.mapping ? tx.json(b.mapping as never) : null;
      await tx`
        INSERT INTO crm_connections (tenant_id, provider, token_encrypted, status, settings, connected_by)
        VALUES (${tenantId}, 'hubspot', ${sealed}, 'active', COALESCE(${settings}, '{}'::jsonb), ${userId})
        ON CONFLICT (tenant_id, provider) DO UPDATE SET token_encrypted = EXCLUDED.token_encrypted, status = 'active', last_error = NULL,
          settings = CASE WHEN ${settings}::jsonb IS NULL THEN crm_connections.settings ELSE EXCLUDED.settings END, connected_by = EXCLUDED.connected_by, updated_at = now()`;
      await audit(tx, c, "crm.connect", "crm", "hubspot");
    });
    return c.json({ connected: true as const });
  });

  r.patch("/crm/hubspot/mapping", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, updateHubspotMappingSchema);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`UPDATE crm_connections SET settings = ${tx.json(b.mapping as never)}, updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'hubspot' RETURNING 1`;
      if (rows.length) await audit(tx, c, "crm.update", "crm", "hubspot", { properties: Object.keys(b.mapping.properties) });
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("HubSpot is not connected");
    return c.json({ mapping: b.mapping });
  });

  r.delete("/crm/hubspot/connection", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`DELETE FROM crm_connections WHERE tenant_id = ${tenantId} AND provider = 'hubspot' RETURNING 1`;
      if (rows.length) await audit(tx, c, "crm.disconnect", "crm", "hubspot");
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("HubSpot is not connected");
    return c.json({ ok: true as const });
  });

  /** Upsert one contact with the saved mapping so the admin can check the result in HubSpot. */
  r.post("/crm/hubspot/test-contact", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const key = needKey();
    const lim = await limiter.hit(`hubspot-test:${tenantId}`, 10, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const b = await parseBody(c, hubspotTestContactSchema);
    const [x] = await withTenant(db, tenantId, (tx) => tx<ConnRow[]>`SELECT token_encrypted, status, last_error, settings, last_sync_at, created_at FROM crm_connections WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`);
    if (!x) throw Errors.notFound("HubSpot is not connected");
    const mapping = parseHubspotMapping(x.settings);
    try {
      const res = await client(openHubspotToken(key, tenantId, x.tokenEncrypted)).upsertContact({
        email: b.email, properties: buildHubSpotProperties({ name: b.name ?? "Lumi Test", phone: undefined, need: "Test contact from Lumi", budget: "n/a", timeline: "n/a", score: 1 }, mapping, `${cfg.appUrl.replace(/\/+$/, "")}/inbox`),
      });
      await withTenant(db, tenantId, async (tx) => {
        await tx`UPDATE crm_connections SET status = 'active', last_error = NULL, last_sync_at = now(), updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
        await tx`INSERT INTO crm_sync_log (tenant_id, provider, trigger, status, action, hubspot_id, attempts, synced_at) VALUES (${tenantId}, 'hubspot', 'test', 'ok', ${res.action}, ${res.id}, 1, now())`;
        await audit(tx, c, "crm.test_contact", "crm", "hubspot", { action: res.action });
      });
      return c.json({ id: res.id, action: res.action });
    } catch (e) {
      const msg = crmErrorText(e);
      await withTenant(db, tenantId, async (tx) => {
        await tx`UPDATE crm_connections SET last_error = ${msg}, status = ${e instanceof HubSpotError && e.authFailure ? "error" : x.status}, updated_at = now() WHERE tenant_id = ${tenantId} AND provider = 'hubspot'`;
        await tx`INSERT INTO crm_sync_log (tenant_id, provider, trigger, status, error, attempts) VALUES (${tenantId}, 'hubspot', 'test', 'failed', ${msg}, 1)`;
      });
      throw new AppError(502, "service_unavailable", msg);
    }
  });
  return r;
}
