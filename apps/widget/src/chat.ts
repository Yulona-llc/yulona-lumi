import { ApiError, type Api } from "./api";
import { clearState, loadState, saveState, type OutboxItem, type Persisted } from "./storage";
import { startTransport, type Transport } from "./transport";
import type { ChatMessage, Session, UiEvent, WidgetRuntimeConfig, WireMessage } from "./types";

const uuid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export interface ChatState {
  phase: "loading" | "prechat" | "ready" | "error";
  config?: WidgetRuntimeConfig;
  messages: ChatMessage[];
  typing: boolean;
  conn: "live" | "polling" | "offline";
  /** componentKey -> submitted (interactive components lock after use) */
  answered: Record<string, true>;
}

type Listener = () => void;

export interface ChatOptions {
  transport?: typeof startTransport;
  /** Base for outbox retry backoff (ms); overridable for tests. */
  retryBase?: number;
  typingThrottle?: number;
}

export class Chat {
  state: ChatState = { phase: "loading", messages: [], typing: false, conn: "polling", answered: {} };
  private listeners = new Set<Listener>();
  private p: Persisted;
  private transport?: Transport;
  private flushing = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private typingTimer?: ReturnType<typeof setTimeout>;
  private lastTypingSent = 0;
  private started = false;

  constructor(private api: Api, private widgetKey: string, private opts: ChatOptions = {}) {
    this.p = loadState(widgetKey);
    if (typeof window !== "undefined") window.addEventListener("online", () => void this.flush());
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private persist() {
    saveState(this.widgetKey, this.p);
  }

  async init() {
    if (this.started) return;
    this.started = true;
    try {
      const config = await this.api.getConfig();
      const needsPreChat = !!config.preChat?.enabled && !this.p.session && !this.p.preChatDone;
      this.set({ config, phase: needsPreChat ? "prechat" : "ready" });
      if (!needsPreChat) await this.connect();
    } catch {
      this.set({ phase: "error" });
    }
  }

  retry() {
    this.started = false;
    this.set({ phase: "loading" });
    return this.init();
  }

  async submitPreChat(visitor: Record<string, string>) {
    this.p.preChatDone = true;
    this.persist();
    this.set({ phase: "ready" });
    await this.connect(visitor);
  }

  private restorePending() {
    return this.p.outbox.map<ChatMessage>((o) => ({
      id: `local-${o.clientId}`,
      clientId: o.clientId,
      role: "user",
      text: o.text,
      createdAt: new Date().toISOString(),
      state: "sending",
    }));
  }

  private async ensureSession(visitor?: Record<string, string>): Promise<Session> {
    if (this.p.session) return this.p.session;
    const { session, messages } = await this.api.startConversation(visitor, this.p.visitorId);
    this.p.session = session;
    this.p.visitorId = session.visitorId ?? this.p.visitorId;
    this.persist();
    this.scheduleRefresh();
    messages.forEach((m) => this.receive(m)); // includes the configured welcome message
    return session;
  }

  private async connect(visitor?: Record<string, string>) {
    this.set({ messages: this.restorePending() });
    try {
      const s = await this.ensureSession(visitor);
      await this.sync();
      this.transport?.stop();
      this.transport = (this.opts.transport ?? startTransport)(this.api, s, this.widgetKey, {
        onEvent: (e) => (e.type === "message" ? this.receive(e.message) : e.from !== "contact" && this.setTyping(e.on)),
        onSync: () => void this.sync(),
        onStatus: (conn) => this.set({ conn }),
        onAuthError: () => void this.reset(),
      });
      this.scheduleRefresh();
      void this.flush();
    } catch (e) {
      if (e instanceof ApiError && !e.retryable) return this.set({ phase: "error" });
      this.set({ conn: "offline" });
      this.scheduleRetry(() => this.connect(visitor));
    }
  }

  /** Session expired/revoked: drop it and start a fresh conversation (visitorId is kept). */
  async reset() {
    this.transport?.stop();
    clearTimeout(this.refreshTimer);
    delete this.p.session;
    this.persist();
    this.set({ messages: [], answered: {}, typing: false });
    await this.connect();
  }

  forget() {
    this.transport?.stop();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.retryTimer);
    clearState(this.widgetKey);
  }

  /** Refresh the session token at ~70% of its lifetime; transports read the token at (re)connect. */
  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    const s = this.p.session;
    if (!s?.expiresAt) return;
    const remaining = s.expiresAt - Date.now();
    this.refreshTimer = setTimeout(async () => {
      const cur = this.p.session;
      if (!cur) return;
      try {
        Object.assign(cur, await this.api.refresh(cur));
        this.persist();
        this.scheduleRefresh();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) void this.reset();
        else this.refreshTimer = setTimeout(() => this.scheduleRefresh(), 30000);
      }
    }, Math.max(1000, remaining * 0.7));
  }

  private setTyping(on: boolean) {
    clearTimeout(this.typingTimer);
    this.set({ typing: on });
    // Safety: never leave the indicator stuck if the "off" event is lost.
    if (on) this.typingTimer = setTimeout(() => this.set({ typing: false }), 15000);
  }

  private receive(m: WireMessage) {
    this.insert(m);
    if (m.role !== "user") this.setTyping(false);
  }

  private insert(m: WireMessage) {
    const msgs = this.state.messages;
    if (msgs.some((x) => x.id === m.id)) return;
    const next: ChatMessage = { ...m, state: m.role === "user" ? "sent" : undefined };
    const merged = [...msgs, next].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    this.set({ messages: merged });
  }

  /** Catch up via GET /messages?after=<last server id>. Safe to call repeatedly. */
  async sync() {
    const s = this.p.session;
    if (!s) return;
    try {
      const last = [...this.state.messages].reverse().find((m) => !m.id.startsWith("local-"));
      (await this.api.history(s, last?.id)).forEach((m) => this.receive(m));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) await this.reset();
    }
  }

  /** Optimistic send, persisted in the outbox so it survives offline periods and reloads. */
  send(text: string) {
    const t = text.trim();
    if (!t) return;
    const clientId = uuid();
    const item: OutboxItem = { clientId, text: t.slice(0, 4000) };
    this.p.outbox.push(item);
    this.persist();
    this.set({
      messages: [
        ...this.state.messages,
        { id: `local-${clientId}`, clientId, role: "user", text: item.text, createdAt: new Date().toISOString(), state: "sending" },
      ],
    });
    void this.flush();
  }

  /** Relay visitor typing (throttled, best effort). */
  notifyTyping() {
    const s = this.p.session;
    const now = Date.now();
    if (!s || now - this.lastTypingSent < (this.opts.typingThrottle ?? 3000)) return;
    this.lastTypingSent = now;
    this.api.typing(s, true).catch(() => {});
  }

  retryFailed() {
    this.retries = 0;
    const failed = this.state.messages.filter((m) => m.state === "failed" && m.clientId && m.text);
    failed.forEach((m) => this.p.outbox.push({ clientId: m.clientId!, text: m.text! }));
    this.persist();
    this.set({ messages: this.state.messages.map((m) => (m.state === "failed" ? { ...m, state: "sending" } : m)) });
    void this.flush();
  }

  private scheduleRetry(fn: () => unknown, minMs = 0) {
    clearTimeout(this.retryTimer);
    const base = this.opts.retryBase ?? 1000;
    const delay = Math.max(minMs, Math.min(30000, base * 2 ** this.retries++));
    this.retryTimer = setTimeout(() => void fn(), delay);
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.p.outbox.length) {
        const item = this.p.outbox[0]!;
        try {
          const s = await this.ensureSession();
          // Idempotent per clientMessageId, so retrying after an ambiguous failure never duplicates.
          const m = await this.api.send(s, item.text, item.clientId);
          this.p.outbox.shift();
          this.persist();
          this.retries = 0;
          this.set({ messages: this.state.messages.filter((x) => x.clientId !== item.clientId && x.id !== m.id) });
          this.insert(m);
          this.setTyping(true);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            await this.reset();
            continue;
          }
          if (e instanceof ApiError && !e.retryable) {
            this.p.outbox.shift();
            this.persist();
            this.mark(item.clientId, "failed");
            continue;
          }
          this.set({ conn: "offline" });
          this.scheduleRetry(() => this.flush(), e instanceof ApiError && e.retryAfter ? e.retryAfter * 1000 : 0);
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private mark(clientId: string, state: ChatMessage["state"]) {
    this.set({ messages: this.state.messages.map((m) => (m.clientId === clientId ? { ...m, state } : m)) });
  }

  /** Form / button / calendar submission. Returns true when the server accepted it. */
  async sendUiEvent(key: string, e: UiEvent): Promise<boolean> {
    const s = this.p.session;
    if (!s || !e.messageId) return false;
    try {
      const m = await this.api.uiEvent(s, e, uuid());
      this.set({ answered: { ...this.state.answered, [key]: true } });
      this.insert(m);
      this.setTyping(true);
      return true;
    } catch {
      return false;
    }
  }
}
