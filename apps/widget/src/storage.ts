import type { Session } from "./types";

/** localStorage with graceful fallback (private mode / blocked storage / CSP sandbox). */
const mem = new Map<string, string>();
function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return mem.get(k) ?? null;
  }
}
function set(k: string, v: string | null) {
  try {
    v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  } catch {
    v === null ? mem.delete(k) : mem.set(k, v);
  }
}

export interface OutboxItem {
  clientId: string;
  text: string;
}
export interface Persisted {
  session?: Session;
  outbox: OutboxItem[];
  preChatDone?: boolean;
  /** Stable anonymous id; links future conversations to the same contact. */
  visitorId?: string;
}

export function loadState(widgetKey: string): Persisted {
  try {
    const raw = get(`yulona:${widgetKey}`);
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      if (Array.isArray(p.outbox)) return p;
    }
  } catch {
    /* corrupt -> reset */
  }
  return { outbox: [] };
}
export function saveState(widgetKey: string, p: Persisted) {
  set(`yulona:${widgetKey}`, JSON.stringify(p));
}
export function clearState(widgetKey: string) {
  set(`yulona:${widgetKey}`, null);
}
