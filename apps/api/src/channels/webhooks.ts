import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { credentialAad, type ChannelRegistry, type WebhookRequest } from "@yulona/channels";
import type { AppEnv } from "../context";
import { enforceLimit } from "../middleware";
import type { ConvDeps } from "../conversations/common";
import { decryptCredentials } from "../conversations/crypto";
import { ingestInbound } from "./ingest";
import { resolveConnection } from "./repos";
import { CONNECTABLE_CHANNELS } from "./schemas";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = {
  ip: { limit: 1200, windowMs: 60_000 },
  connection: { limit: 600, windowMs: 60_000 },
  badSignature: { limit: 20, windowMs: 60_000 },
};

/**
 * Public webhook receivers: `/api/v1/webhooks/channels/:channel/:connectionId` (no JWT).
 * Trust comes from the provider signature (HMAC / secret header, constant-time), verified over the raw
 * body BEFORE anything is parsed. Unknown/mismatched/disabled connections all answer 404 so ids cannot
 * be probed. Replays are dropped via `channel_webhook_events` (and Slack's timestamp window).
 */
export function channelWebhookRoutes({ cfg, db, limiter, log, registry }: Omit<ConvDeps, "realtime"> & { registry: ChannelRegistry; log?: { warn: (m: string, f?: Record<string, unknown>) => void } }) {
  const r = new Hono<AppEnv>();
  const notFound = (c: import("hono").Context) => c.json({ error: { code: "not_found", message: "Not found", requestId: c.get("requestId") } }, 404);

  async function load(c: import("hono").Context<AppEnv>) {
    const channel = c.req.param("channel") ?? "";
    const id = c.req.param("connectionId") ?? "";
    if (!(CONNECTABLE_CHANNELS as readonly string[]).includes(channel) || !UUID.test(id)) return null;
    await enforceLimit(limiter, `chwh:ip:${c.get("ip")}`, LIMITS.ip);
    const conn = await resolveConnection(db, id);
    if (!conn || conn.channel !== channel || conn.status === "disabled" || conn.tenantStatus !== "active") return null;
    await enforceLimit(limiter, `chwh:conn:${id}`, LIMITS.connection);
    if (!cfg.encryptionKey) return null;
    let credentials;
    try {
      credentials = decryptCredentials(cfg.encryptionKey, conn.credentialsEncrypted, credentialAad(conn.tenantId, conn.connectionId));
    } catch {
      return null;
    }
    const adapter = registry.get(conn.channel);
    return adapter ? { conn, credentials, adapter } : null;
  }

  const toRequest = (c: import("hono").Context, rawBody: string): WebhookRequest => ({
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    rawBody,
    query: c.req.query(),
  });

  // Meta (WhatsApp/Messenger/Instagram) GET handshake. Other channels do not use GET.
  r.get("/:channel/:connectionId", async (c) => {
    const ctx = await load(c);
    if (!ctx || !ctx.adapter.handleVerification) return notFound(c);
    const res = ctx.adapter.handleVerification(toRequest(c, ""), ctx.credentials);
    if (!res) return notFound(c);
    return c.body(res.body, res.status as 200, { "content-type": res.contentType ?? "text/plain; charset=utf-8", "cache-control": "no-store" });
  });

  r.post("/:channel/:connectionId", async (c) => {
    const ctx = await load(c);
    if (!ctx) return notFound(c);
    const raw = await c.req.text();
    const req = toRequest(c, raw);
    if (!(await ctx.adapter.verifyWebhook(req, ctx.credentials))) {
      await enforceLimit(limiter, `chwh:bad:${c.get("ip")}:${ctx.conn.connectionId}`, LIMITS.badSignature);
      log?.warn("channel webhook signature rejected", { connectionId: ctx.conn.connectionId, channel: ctx.conn.channel, requestId: c.get("requestId") });
      return c.json({ error: { code: "unauthorized", message: "Invalid signature", requestId: c.get("requestId") } }, 401);
    }
    const proto = ctx.adapter.respondToPost?.(req);
    if (proto) return c.body(proto.body, proto.status as 200, { "content-type": proto.contentType ?? "text/plain; charset=utf-8" });

    const msgs = ctx.adapter.parseInbound(req).slice(0, 100);
    if (msgs.length) {
      await withTenant(db, ctx.conn.tenantId, (tx) =>
        ingestInbound(tx, ctx.conn.tenantId, { id: ctx.conn.connectionId, channel: ctx.conn.channel, agentId: ctx.conn.agentId }, msgs));
    }
    return c.json({ ok: true });
  });

  return r;
}
