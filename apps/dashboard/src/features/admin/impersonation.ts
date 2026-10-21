import { useSyncExternalStore } from "react";
import { adminApi } from "./api";

export interface ImpState { sessionId: string; tenantName: string; reason: string }
let state: ImpState | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export const impersonation = {
  get: () => state,
  start: (s: ImpState) => { state = s; emit(); },
  clear: () => { state = null; emit(); },
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  /** Revoke server-side (best effort, needs the admin token still in memory) then forget locally. */
  end: async () => { const s = state; state = null; emit(); if (s) await adminApi.endImpersonation(s.sessionId).catch(() => undefined); },
};
export const useImpersonation = () => useSyncExternalStore(impersonation.subscribe, impersonation.get);
