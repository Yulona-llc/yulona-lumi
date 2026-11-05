import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { withTenant } from "@yulona/db";
import {
  WIDGET_UI_SCHEMA_VERSION, emailSchema, publicListMessagesQuerySchema, publicSendMessageSchema, startConversationSchema,
  typingSchema, uiEventSchema, type RealtimeEvent, type UiEvent,
} from "@yulona/shared";
import type { Tx } from "@yulona/db";
import { isAgentLive, loadAgent } from "@yulona/ai-runtime";
import type { AppEnv } from "../context";
import { Errors, AppError } from "../errors";
import { parseBody } from "../http";
import { enforceLimit, errorResponse } from "../middleware";
import { parseQuery, type ConvDeps } from "../conversations/common";
import { toPublicMessage, type MessageRow } from "../conversations/dto";
import { enqueueAiRespond } from "../conversations/enqueue";
import { originAllowed } from "../conversations/origin";
import {
  ContactsRepository, ConversationsRepository, MessagesRepository, WidgetSessionsRepository, WidgetsRepository, resolveWidget,
  type ResolvedWidget,
} from "../conversations/repos";
import { signWidgetSession, verifyWidgetSession } from "../conversations/widget-session";
import { announce, socketHandlers, upgradeWebSocket } from "../realtime/ws";
import type { Conn } from "../realtime/hub";
import { assertWithinLimit } from "../platform/limits";
import { openTurnstileSecret, verifyTurnstile } from "../conversations/turnstile";

interface PubSession { id: string; conversationId: string; contactId: string }
type PubEnv = {
  Variables: AppEnv["Variables"] & { pub: ResolvedWidget & { origin: string }; session: PubSession };
};

const WIDGET_KEY_RE = /^wk_[A-Za-z0-9_-]{10,64}$/;
const LIMITS = {
  config: { limit: 120, windowMs: 60_000 },
  start: { limit: 10, windowMs: 10 * 60_000 },
  message: { limit: 30, windowMs: 60_000 },
  typing: { limit: 60, windowMs: 60_000 },
  refresh: { limit: 20, windowMs: 60_000 },
  history: { limit: 120, windowMs: 60_000 },
  /** Turnstile siteverify calls per widget + IP (keeps the endpoint from being used to hammer Cloudflare) */
  captcha: { limit: 30, windowMs: 10 * 60_000 },
  /** honeypot hits per widget + IP, answered with a fake success until the limit, then 429 */
  honeypot: { limit: 20, windowMs: 10 * 60_000 },
};
const contactBlocked = () => new AppError(403, "contact_blocked", "This conversation has ended and can't be continued.");

/** The dashboard itself may always load the widget (the live preview in the widget settings) without being added to "allowed domains". */
function originCheck(cfg: ConvDeps["cfg"]) {
  const dashboardOrigin = (() => { try { return new URL(cfg.appUrl).origin; } catch { return null; } })();
  return (origin: string | undefined | null, allowed: readonly string[]) => (!!dashboardOrigin && origin === dashboardOrigin) || originAllowed(origin, allowed, cfg.isProd);
}

export function publicWidgetRoutes({ cfg, db, limiter, realtime }: ConvDeps) {
  const originOk = originCheck(cfg);
  const r = new Hono<PubEnv>();
  const ttlSeconds = cfg.widgetSessionTtlHours * 3600;

  r.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => errorResponse(c, 413, "payload_too_large", "Request body too large") }));

  // CORS + widget key + origin allowlist. Preflight cannot carry the key, so it is answered for any origin;
  // every real request is checked against the widget's allowlist before anything else happens.
  r.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Widget-Key",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
    }
    const key = c.req.header("x-widget-key") ?? c.req.query("key") ?? "";
    if (!WIDGET_KEY_RE.test(key)) throw Errors.forbidden("Invalid widget key");
    const w = await resolveWidget(db, key);
    if (!w || !w.enabled || w.tenantStatus !== "active") throw Errors.forbidden("Widget unavailable");
    if (!originOk(origin, w.allowedDomains)) throw Errors.forbidden("Origin not allowed");
    c.set("pub", { ...w, origin: origin! });
    c.header("Access-Control-Allow-Origin", origin!);
    c.header("Access-Control-Expose-Headers", "Retry-After, X-Request-Id");
    c.header("Vary", "Origin");
    await next();
  });

  /** `allowBlockedRead`: a visitor blocked for abuse (session revoked in the same step as the closing message) may still READ their own conversation for a few minutes. */
  const sessionGuard = (allowBlockedRead: boolean): MiddlewareHandler<PubEnv> => async (c, next) => {
    const pub = c.get("pub");
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(c.req.header("authorization") ?? "");
    const claims = m ? await verifyWidgetSession(cfg.jwtSecret, m[1]!) : null;
    if (!claims || claims.tid !== pub.tenantId || claims.wid !== pub.widgetId) throw Errors.unauthorized("Invalid or expired session");
    const ok = await withTenant(db, claims.tid, (tx) => {
      const sessions = new WidgetSessionsRepository(tx, claims.tid);
      return allowBlockedRead ? sessions.isReadable(claims.sub, claims.wid, claims.cid) : sessions.isActive(claims.sub, claims.wid, claims.cid);
    });
    if (!ok) throw Errors.unauthorized("Invalid or expired session");
    // A blocked contact (abuse) keeps no access even if a session token is still valid.
    const blocked = await withTenant(db, claims.tid, async (tx) => {
      const [r] = await tx<{ b: boolean }[]>`
        SELECT (ct.blocked_at IS NOT NULL) AS b FROM widget_sessions ws
        JOIN contacts ct ON ct.tenant_id = ws.tenant_id AND ct.id = ws.contact_id
        WHERE ws.tenant_id = ${claims.tid} AND ws.id = ${claims.sub}`;
      return r?.b === true;
    });
    if (blocked && !allowBlockedRead) throw contactBlocked();
    c.set("session", { id: claims.sub, conversationId: claims.cid, contactId: claims.ctid });
    await next();
  };
  const needSession = sessionGuard(false);
  const readSession = sessionGuard(true);

  const ipOf = (c: Context) => c.get("ip") as string;
  const state = (conv: { id: string; status: string; handler: string }) => ({ id: conv.id, status: conv.status, handler: conv.handler });

  // ---- config
  r.get("/config", async (c) => {
    const pub = c.get("pub");
    await enforceLimit(limiter, `pw:cfg:${pub.widgetId}:${ipOf(c)}`, LIMITS.config);
    c.header("Cache-Control", "private, max-age=60");
    // The widget's agent is not live (never published, archived or unassigned): the widget shows an offline notice.
    const { live, avatar, welcome } = await withTenant(db, pub.tenantId, async (tx) => {
      const live = await isAgentLive(tx, pub.tenantId, pub.agentId);
      return {
        live,
        avatar: await new WidgetsRepository(tx, pub.tenantId).avatarEtag(pub.widgetId),
        // Shown by the widget before any conversation exists (same text the conversation start stores as the first message).
        welcome: pub.config?.welcomeMessage || (live ? (await loadAgent(tx, pub.tenantId, pub.agentId))?.greeting : undefined) || null,
      };
    });
    // An uploaded avatar wins over the optional image link; it is served by `/public/widgets/:key/avatar`.
    const config = avatar
      ? { ...pub.config, avatarUrl: `${cfg.publicApiUrl ?? new URL(c.req.url).origin}/api/v1/public/widgets/${c.req.header("x-widget-key") ?? c.req.query("key")}/avatar?v=${avatar}` }
      : pub.config;
    return c.json({
      widgetId: pub.widgetId, name: pub.name, config, prechat: pub.prechat, unavailable: !live, welcome,
      schemaVersion: WIDGET_UI_SCHEMA_VERSION, features: { sse: true, ws: true },
    });
  });

  // ---- start conversation
  r.post("/conversations", async (c) => {
    const pub = c.get("pub");
    await enforceLimit(limiter, `pw:conv:${pub.widgetId}:${ipOf(c)}`, LIMITS.start);
    const body = await parseBody(c, startConversationSchema);
    const missing = (pub.prechat?.enabled ? pub.prechat.fields : []).filter((f) => f.required && !body.visitor?.[f.name]).map((f) => ({ path: `visitor.${f.name}`, message: "Required" }));
    if (missing.length) throw Errors.validation(missing);

    const { tenantId } = pub;
    // ---- bot protection: honeypot, then Cloudflare Turnstile (fail closed)
    const prot = pub.config?.protection;
    if (prot?.honeypot !== false && body.hp?.trim()) {
      await enforceLimit(limiter, `pw:hp:${pub.widgetId}:${ipOf(c)}`, LIMITS.honeypot);
      // looks like success so the bot moves on; nothing is stored and the token cannot be used for anything
      return c.json({
        sessionToken: `${crypto.randomUUID()}.${crypto.randomUUID()}.${crypto.randomUUID()}`, expiresIn: ttlSeconds, visitorId: crypto.randomUUID(),
        conversation: { id: crypto.randomUUID(), status: "open", handler: "ai" }, messages: [], unavailable: false,
      }, 201);
    }
    const ts = prot?.turnstile;
    if (ts?.enabled) {
      await enforceLimit(limiter, `pw:ts:${pub.widgetId}:${ipOf(c)}`, LIMITS.captcha);
      const enc = await withTenant(db, tenantId, (tx) => new WidgetsRepository(tx, tenantId).turnstileSecretEnc(pub.widgetId));
      let secret: string | null = null;
      try {
        if (enc && cfg.encryptionKey) secret = openTurnstileSecret(cfg.encryptionKey, enc, tenantId, pub.widgetId);
      } catch {
        secret = null;
      }
      const v = secret && ts.siteKey
        ? await verifyTurnstile({ url: cfg.turnstileVerifyUrl, secret, token: body.turnstileToken, ip: ipOf(c) })
        : { ok: false as const, reason: "misconfigured" };
      if (!v.ok) throw new AppError(403, "turnstile_failed", "Verification failed. Reload the page and try again.", { reason: v.reason });
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    let unavailable = false;
    const out = await withTenant(db, tenantId, async (tx) => {
      const contacts = new ContactsRepository(tx, tenantId);
      const visitorId = body.visitorId ?? crypto.randomUUID();
      let contactId = await contacts.findByIdentity("widget", visitorId);
      // blocked visitors cannot start a new conversation: by identity, or from the same IP shortly after a block
      if (contactId ? await contacts.isBlocked(contactId) : ipOf(c) !== "unknown" && (await contacts.blockedRecentlyFromIp(ipOf(c)))) throw contactBlocked();
      if (!contactId) {
        contactId = await contacts.create({});
        await contacts.addIdentity(contactId, "widget", visitorId);
      }
      if (body.visitor) await contacts.fillEmpty(contactId, body.visitor);

      await assertWithinLimit(tx, tenantId, "monthly_conversations"); // plan limit (402)
      const convs = new ConversationsRepository(tx, tenantId);
      const conversationId = await convs.create({ contactId, channel: "widget", widgetId: pub.widgetId, agentId: pub.agentId, metadata: { context: body.context ?? {} } });
      const sessionId = await new WidgetSessionsRepository(tx, tenantId).create({
        widgetId: pub.widgetId, conversationId, contactId, origin: pub.origin, ip: ipOf(c), userAgent: c.req.header("user-agent"), expiresAt,
      });
      const messages = new MessagesRepository(tx, tenantId);
      // The widget's own welcome message wins; otherwise the live agent's greeting (published version). A not-live agent gives no AI greeting.
      const agent = await loadAgent(tx, tenantId, pub.agentId);
      unavailable = !agent;
      const welcome = pub.config?.welcomeMessage || agent?.greeting;
      if (welcome) {
        const { id } = await messages.insert({
          conversationId, senderType: "ai", content: welcome,
          ui: { version: WIDGET_UI_SCHEMA_VERSION, components: [{ type: "message", text: welcome }] },
          metadata: { event: "welcome" },
        });
        void id;
      }
      const rows = await messages.page(conversationId, { limit: 20, visitorOnly: true });
      const conv = (await convs.get(conversationId))!;
      return { visitorId, sessionId, conversationId, contactId, conv, rows };
    });
    const sessionToken = await signWidgetSession(cfg.jwtSecret, {
      sessionId: out.sessionId, tenantId, widgetId: pub.widgetId, conversationId: out.conversationId, contactId: out.contactId, ttlSeconds,
    });
    return c.json({
      sessionToken, expiresIn: ttlSeconds, visitorId: out.visitorId, unavailable,
      conversation: state(out.conv),
      messages: out.rows.reverse().map(toPublicMessage),
    }, 201);
  });

  // ---- session refresh
  r.post("/session/refresh", needSession, async (c) => {
    const pub = c.get("pub");
    const s = c.get("session");
    await enforceLimit(limiter, `pw:refresh:${s.id}`, LIMITS.refresh);
    await withTenant(db, pub.tenantId, (tx) => new WidgetSessionsRepository(tx, pub.tenantId).extend(s.id, new Date(Date.now() + ttlSeconds * 1000)));
    const sessionToken = await signWidgetSession(cfg.jwtSecret, {
      sessionId: s.id, tenantId: pub.tenantId, widgetId: pub.widgetId, conversationId: s.conversationId, contactId: s.contactId, ttlSeconds,
    });
    return c.json({ sessionToken, expiresIn: ttlSeconds });
  });

  // ---- history
  r.get("/messages", readSession, async (c) => {
    const pub = c.get("pub");
    const s = c.get("session");
    await enforceLimit(limiter, `pw:hist:${s.id}`, LIMITS.history);
    const q = parseQuery(c, publicListMessagesQuerySchema);
    if (q.before && q.after) throw Errors.validation([{ path: "before", message: "Use either before or after" }]);
    const { rows, conv } = await withTenant(db, pub.tenantId, async (tx) => ({
      rows: await new MessagesRepository(tx, pub.tenantId).page(s.conversationId, { before: q.before, after: q.after, limit: q.limit, visitorOnly: true }),
      conv: (await new ConversationsRepository(tx, pub.tenantId).get(s.conversationId))!,
    }));
    const page = rows.slice(0, q.limit);
    return c.json({
      items: (q.after ? page : page.reverse()).map(toPublicMessage),
      hasMore: rows.length > q.limit,
      conversation: state(conv),
    });
  });

  /** Store a contact message and enqueue the AI reply atomically. Idempotent per clientMessageId. */
  async function postContactMessage(
    tx: Tx, tenantId: string, s: PubSession,
    m: { content: string; clientMessageId: string; metadata?: Record<string, unknown> },
  ): Promise<{ row: MessageRow; created: boolean }> {
    const convs = new ConversationsRepository(tx, tenantId);
    const conv = await convs.get(s.conversationId, true);
    if (!conv) throw Errors.notFound();
    // blocked contact: nothing is stored and a resolved conversation is never reopened
    if (await new ContactsRepository(tx, tenantId).isBlocked(conv.contactId)) throw contactBlocked();
    const messages = new MessagesRepository(tx, tenantId);
    const { id, created } = await messages.insert({
      conversationId: s.conversationId, senderType: "contact", content: m.content, metadata: m.metadata, clientMessageId: m.clientMessageId,
    });
    if (created) {
      let status = conv.status;
      if (status === "resolved") {
        await convs.setState(s.conversationId, { status: "open" });
        status = "open";
      }
      // Also enqueued while a person is pending: the runtime skips it unless the customer sent the resume keyword.
      await enqueueAiRespond(tx, { tenantId, conversationId: s.conversationId, messageId: id });
    }
    return { row: (await messages.get(id))!, created };
  }

  // ---- send message
  r.post("/messages", needSession, async (c) => {
    const pub = c.get("pub");
    const s = c.get("session");
    await enforceLimit(limiter, `pw:msg:${s.id}`, LIMITS.message);
    const body = await parseBody(c, publicSendMessageSchema);
    if (pub.config?.protection?.honeypot !== false && body.hp?.trim()) {
      await enforceLimit(limiter, `pw:hp:${pub.widgetId}:${ipOf(c)}`, LIMITS.honeypot);
      return c.json({ id: crypto.randomUUID(), senderType: "contact", senderName: null, content: body.text, ui: null, createdAt: new Date().toISOString() }, 201);
    }
    const { row, created } = await withTenant(db, pub.tenantId, (tx) =>
      postContactMessage(tx, pub.tenantId, s, { content: body.text, clientMessageId: body.clientMessageId }));
    return c.json(toPublicMessage(row), created ? 201 : 200);
  });

  // ---- ui events (form / button / calendar)
  function describeEvent(e: UiEvent): { content: string; metadata: Record<string, unknown> } {
    const base = { type: e.type, sourceMessageId: e.messageId, componentId: e.componentId };
    switch (e.type) {
      case "form_submit":
        return {
          content: Object.entries(e.values).map(([k, v]) => `${k}: ${v}`).join("\n").slice(0, 2000) || "(empty form)",
          metadata: { uiEvent: { ...base, values: e.values } },
        };
      case "button_click":
        return { content: (e.label ?? e.value).slice(0, 200), metadata: { uiEvent: { ...base, value: e.value, label: e.label } } };
      case "calendar_select":
        return { content: `Selected time: ${e.start} (${e.timezone})`, metadata: { uiEvent: { ...base, slot: { start: e.start, end: e.end, timezone: e.timezone } } } };
    }
  }
  r.post("/ui-events", needSession, async (c) => {
    const pub = c.get("pub");
    const s = c.get("session");
    await enforceLimit(limiter, `pw:msg:${s.id}`, LIMITS.message);
    const ev = await parseBody(c, uiEventSchema);
    const { content, metadata } = describeEvent(ev);
    const { row, created } = await withTenant(db, pub.tenantId, async (tx) => {
      if (!(await new MessagesRepository(tx, pub.tenantId).belongsToConversation(ev.messageId, s.conversationId))) {
        throw Errors.validation([{ path: "messageId", message: "Unknown message" }]);
      }
      const res = await postContactMessage(tx, pub.tenantId, s, { content, metadata, clientMessageId: ev.clientMessageId });
      if (res.created && ev.type === "form_submit") {
        const patch: { name?: string; email?: string; phone?: string } = {};
        const name = ev.values.name?.trim();
        if (name) patch.name = name.slice(0, 200);
        const email = emailSchema.safeParse(ev.values.email ?? "");
        if (email.success) patch.email = email.data;
        const phone = ev.values.phone?.trim();
        if (phone && phone.length >= 3) patch.phone = phone.slice(0, 40);
        if (Object.keys(patch).length) await new ContactsRepository(tx, pub.tenantId).fillEmpty(s.contactId, patch);
      }
      return res;
    });
    return c.json(toPublicMessage(row), created ? 201 : 200);
  });

  // ---- typing
  r.post("/typing", needSession, async (c) => {
    const pub = c.get("pub");
    const s = c.get("session");
    await enforceLimit(limiter, `pw:typing:${s.id}`, LIMITS.typing);
    const body = await parseBody(c, typingSchema);
    await realtime.publish({ t: pub.tenantId, c: s.conversationId, e: "typing", d: { from: "contact", typing: body.typing } });
    return c.json({ ok: true as const });
  });

  // ---- SSE fallback
  r.get("/stream", needSession, async (c) => {
    const pub = c.get("pub");
    const s = c.get("session");
    const info = { kind: "visitor" as const, tenantId: pub.tenantId, conversationId: s.conversationId, sessionId: s.id };
    const reason = realtime.hub.canAdd(info);
    if (reason) throw new AppError(429, "rate_limited", reason, undefined, { "Retry-After": "10" });
    void realtime.start();
    return streamSSE(c, async (stream) => {
      let conn: Conn | null = null;
      const cleanup = () => {
        if (!conn) return;
        realtime.hub.remove(conn);
        announce(realtime, conn, false);
        conn = null;
      };
      stream.onAbort(cleanup);
      const me: Conn = {
        id: crypto.randomUUID(), ...info,
        send: (ev: RealtimeEvent) => void stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) }).catch(cleanup),
        close: () => void stream.close().catch(() => {}),
      };
      conn = me;
      realtime.hub.add(me);
      announce(realtime, me, true);
      me.send({ type: "ready", kind: "visitor" });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(20_000);
        await stream.write(": ping\n\n").catch(() => {});
      }
      cleanup();
    });
  });

  // ---- WebSocket (token in the first frame, never the URL)
  r.get(
    "/ws",
    upgradeWebSocket((c) => {
      const pub = (c as unknown as Context<PubEnv>).get("pub");
      return socketHandlers(realtime, async (token) => {
        const claims = await verifyWidgetSession(cfg.jwtSecret, token);
        if (!claims || claims.tid !== pub.tenantId || claims.wid !== pub.widgetId) return null;
        const ok = await withTenant(db, claims.tid, (tx) => new WidgetSessionsRepository(tx, claims.tid).isActive(claims.sub, claims.wid, claims.cid));
        return ok ? { kind: "visitor", tenantId: claims.tid, conversationId: claims.cid, sessionId: claims.sub } : null;
      });
    }),
  );

  return r;
}

/**
 * Public, cacheable avatar image: GET /public/widgets/:key/avatar. Loaded by an <img> tag on the customer's site, so there is no CORS
 * preflight and no widget-key header: the key is in the path. Origin policy: when the browser sends Origin or Referer it must match the
 * widget's allowed domains; with neither (privacy settings, direct visit) the public brand image is still served. Only enabled widgets.
 */
export function publicWidgetAvatarRoutes({ cfg, db, limiter }: ConvDeps) {
  const originOk = originCheck(cfg);
  const r = new Hono<AppEnv>();
  r.get("/:key/avatar", async (c) => {
    const key = c.req.param("key");
    const notFound = () => c.body(null, 404, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (!WIDGET_KEY_RE.test(key)) return notFound();
    await enforceLimit(limiter, `pw:avatar:${key}:${c.get("ip") as string}`, LIMITS.history);
    const w = await resolveWidget(db, key);
    if (!w || !w.enabled || w.tenantStatus !== "active") return notFound();
    const origin = c.req.header("origin") ?? (() => { try { return new URL(c.req.header("referer") ?? "").origin; } catch { return undefined; } })();
    if (origin && !originOk(origin, w.allowedDomains)) return c.body(null, 403, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const a = await withTenant(db, w.tenantId, (tx) => new WidgetsRepository(tx, w.tenantId).getAvatar(w.widgetId));
    if (!a) return notFound();
    const headers = {
      ETag: `"${a.etag}"`,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      Vary: "Origin, Referer",
    };
    if (c.req.header("if-none-match")?.replace(/^W\//, "") === `"${a.etag}"`) return c.body(null, 304, headers);
    return c.body(a.data as never, 200, { ...headers, "Content-Type": a.contentType, "Content-Length": String(a.data.length) });
  });
  return r;
}
