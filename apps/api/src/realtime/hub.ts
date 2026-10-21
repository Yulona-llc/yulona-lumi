import type { RealtimeEvent } from "@yulona/shared";

export interface Conn {
  id: string;
  kind: "agent" | "visitor";
  tenantId: string;
  userId?: string;
  conversationId?: string;
  sessionId?: string;
  send(ev: RealtimeEvent): void;
  close(code: number, reason: string): void;
}

export const LIMITS = { perSession: 5, perUser: 5, perTenant: 1000 } as const;

/** In-process registry of live sockets/SSE streams on THIS instance. */
export class Hub {
  private byTenant = new Map<string, Set<Conn>>();

  /** Returns a reason string if the connection would exceed a limit. */
  canAdd(c: Pick<Conn, "tenantId" | "kind" | "userId" | "sessionId">): string | null {
    const set = this.byTenant.get(c.tenantId);
    if (!set) return null;
    if (set.size >= LIMITS.perTenant) return "tenant connection limit reached";
    let same = 0;
    for (const o of set) {
      if (c.kind === "agent" && o.kind === "agent" && o.userId === c.userId) same++;
      if (c.kind === "visitor" && o.kind === "visitor" && o.sessionId === c.sessionId) same++;
    }
    if (c.kind === "agent" && same >= LIMITS.perUser) return "too many connections for this user";
    if (c.kind === "visitor" && same >= LIMITS.perSession) return "too many connections for this session";
    return null;
  }
  add(c: Conn): void {
    let set = this.byTenant.get(c.tenantId);
    if (!set) this.byTenant.set(c.tenantId, (set = new Set()));
    set.add(c);
  }
  remove(c: Conn): void {
    const set = this.byTenant.get(c.tenantId);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.byTenant.delete(c.tenantId);
  }
  hasTenant(tenantId: string): boolean {
    return this.byTenant.has(tenantId);
  }
  count(tenantId?: string): number {
    if (tenantId) return this.byTenant.get(tenantId)?.size ?? 0;
    let n = 0;
    for (const s of this.byTenant.values()) n += s.size;
    return n;
  }
  countWhere(tenantId: string, pred: (c: Conn) => boolean): number {
    let n = 0;
    for (const c of this.byTenant.get(tenantId) ?? []) if (pred(c)) n++;
    return n;
  }
  toAgents(tenantId: string, ev: RealtimeEvent): void {
    for (const c of this.byTenant.get(tenantId) ?? []) if (c.kind === "agent") this.safeSend(c, ev);
  }
  toVisitors(tenantId: string, conversationId: string, ev: RealtimeEvent): void {
    for (const c of this.byTenant.get(tenantId) ?? []) {
      if (c.kind === "visitor" && c.conversationId === conversationId) this.safeSend(c, ev);
    }
  }
  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const s of this.byTenant.values()) for (const c of [...s]) c.close(code, reason);
  }
  private safeSend(c: Conn, ev: RealtimeEvent) {
    try {
      c.send(ev);
    } catch {
      this.remove(c);
    }
  }
}
