import { withTenant, type Db } from "@yulona/db";
import type { Logger, RealtimeEvent } from "@yulona/shared";
import { isVisitorVisible, toConversationSummary, toMessageDto, toPublicMessage } from "../conversations/dto";
import { ConversationsRepository, MessagesRepository } from "../conversations/repos";
import { Hub } from "./hub";

export const PG_CHANNEL = "yulona_rt";
const REDIS_CHANNEL = "yulona:rt:ephemeral";

interface Envelope {
  t: string; // tenant id
  c?: string; // conversation id
  e: "message.created" | "conversation.updated" | "typing" | "presence";
  id?: string; // row id for hydration
  d?: Record<string, unknown>;
}

export interface RealtimeOptions {
  db: Db;
  log: Logger;
  redisUrl?: string;
}

/**
 * Cross-process realtime. DB triggers NOTIFY on every message insert / conversation state change
 * (so the AI worker needs no wiring); this service LISTENs, hydrates the row under RLS and fans out
 * to local sockets. Ephemeral frames (typing/presence) go over Redis pub/sub if configured, else NOTIFY.
 */
export class Realtime {
  readonly hub = new Hub();
  private started: Promise<void> | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private redisPub: Bun.RedisClient | null = null;
  private redisSub: Bun.RedisClient | null = null;
  private redisOk = false;

  constructor(private readonly o: RealtimeOptions) {}

  /** Idempotent; called eagerly by the server and lazily on first socket. */
  start(): Promise<void> {
    this.started ??= this.doStart().catch((e) => {
      this.o.log.error("realtime start failed", { err: (e as Error).message });
      this.started = null;
    });
    return this.started;
  }

  private async doStart() {
    const l = await this.o.db.listen(PG_CHANNEL, (payload) => void this.handle(payload));
    this.unlisten = () => l.unlisten();
    if (this.o.redisUrl) {
      try {
        this.redisPub = new Bun.RedisClient(this.o.redisUrl);
        this.redisSub = new Bun.RedisClient(this.o.redisUrl);
        await this.redisSub.subscribe(REDIS_CHANNEL, (msg: string) => void this.handle(msg));
        this.redisOk = true;
      } catch (e) {
        this.o.log.warn("realtime redis pub/sub unavailable; using postgres notify", { err: (e as Error).message });
        this.redisOk = false;
      }
    }
  }

  async stop(): Promise<void> {
    this.hub.closeAll();
    await this.unlisten?.().catch(() => {});
    try { this.redisSub?.close(); this.redisPub?.close(); } catch {}
    this.started = null;
  }

  /** Publish an ephemeral event (typing / presence). */
  async publish(env: Envelope): Promise<void> {
    const payload = JSON.stringify(env);
    if (this.redisOk && this.redisPub) {
      try {
        await this.redisPub.publish(REDIS_CHANNEL, payload);
        return;
      } catch (e) {
        this.o.log.warn("redis publish failed; falling back to notify", { err: (e as Error).message });
      }
    }
    await this.o.db`SELECT pg_notify(${PG_CHANNEL}, ${payload})`;
  }

  /** Visible for tests. */
  async handle(payload: string): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(payload);
    } catch {
      return;
    }
    if (!env?.t || !this.hub.hasTenant(env.t)) return; // nobody connected for this tenant on this instance
    try {
      await this.dispatch(env);
    } catch (e) {
      this.o.log.warn("realtime dispatch failed", { err: (e as Error).message, event: env.e });
    }
  }

  private async dispatch(env: Envelope) {
    const { hub } = this;
    const tenantId = env.t;
    switch (env.e) {
      case "message.created": {
        if (!env.id || !env.c) return;
        const row = await withTenant(this.o.db, tenantId, (tx) => new MessagesRepository(tx, tenantId).get(env.id!));
        if (!row) return;
        hub.toAgents(tenantId, { type: "message.created", conversationId: row.conversationId, message: toMessageDto(row) });
        if (isVisitorVisible(row.senderType)) {
          hub.toVisitors(tenantId, row.conversationId, { type: "message.created", conversationId: row.conversationId, message: toPublicMessage(row) });
        }
        return;
      }
      case "conversation.updated": {
        if (!env.id) return;
        const row = await withTenant(this.o.db, tenantId, (tx) => new ConversationsRepository(tx, tenantId).get(env.id!));
        if (!row) return;
        hub.toAgents(tenantId, { type: "conversation.updated", conversation: toConversationSummary(row) });
        hub.toVisitors(tenantId, row.id, { type: "conversation.updated", conversation: { id: row.id, status: row.status, handler: row.handler } });
        return;
      }
      case "typing": {
        const d = env.d ?? {};
        const from = d.from === "human" || d.from === "ai" || d.from === "contact" ? d.from : null;
        if (!from || !env.c) return;
        const ev: RealtimeEvent = { type: "typing", conversationId: env.c, from, userId: typeof d.userId === "string" ? d.userId : undefined, typing: d.typing === true };
        hub.toAgents(tenantId, ev);
        if (from !== "contact") hub.toVisitors(tenantId, env.c, ev);
        return;
      }
      case "presence": {
        const d = env.d ?? {};
        const subject = d.subject === "agent" ? "agent" : "contact";
        const ev: RealtimeEvent = { type: "presence", subject, conversationId: env.c, userId: typeof d.userId === "string" ? d.userId : undefined, online: d.online === true };
        hub.toAgents(tenantId, ev);
        if (subject === "agent" && env.c) hub.toVisitors(tenantId, env.c, ev);
        return;
      }
    }
  }
}

export function createRealtime(o: RealtimeOptions): Realtime {
  return new Realtime(o);
}
