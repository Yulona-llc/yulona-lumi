import { useSyncExternalStore } from "react";
import { z } from "zod";
import { request as rawRequest, type Opts } from "../../api/client";

export type AuthType = "none" | "bearer" | "api_key" | "basic" | "hmac";
export interface Connection {
  id: string; name: string; kind: string; baseUrl: string; authType: AuthType; authHeaderName: string | null; testPath: string | null;
  hasSecret: boolean; createdBy: string | null; createdAt: string; updatedAt: string;
}
export interface ConnectionInput { name: string; baseUrl: string; authType: AuthType; authHeaderName?: string; secret?: string; testPath?: string }
export interface ErrInfo { code: string; message: string; status?: number }
export interface RedactedRequest { method: string; url: string; headers: Record<string, string>; body?: string }
export interface ConnectionTest { ok: boolean; status?: number; latencyMs?: number; contentType?: string; request?: RedactedRequest; excerpt?: string; error: ErrInfo | null }
export interface FieldNode { name: string; path: string; type: string; sample?: unknown; length?: number; itemType?: string; children?: FieldNode[] }
export interface FieldTree { rootType: string; fields: FieldNode[] }
export interface ToolTestResult {
  ok: boolean; status?: number; latencyMs?: number; attempts?: number; request?: RedactedRequest;
  response?: { status: number; contentType?: string; excerpt: string; truncated: boolean };
  mapped: Record<string, unknown> | null; fieldTree: FieldTree | null; error: ErrInfo | null;
}
export interface ToolRun { name: string; success: boolean; error: string | null; latencyMs: number; createdAt: string }

const request = <T,>(path: string, o: Opts<T> = {}) => rawRequest<T>(path, { ...o, schema: z.any() as z.ZodType<T> });
const A = { auth: true } as const;
const j = (method: string, body?: unknown) => ({ ...A, method, body });

export const toolKeys = {
  connections: ["tool-connections"] as const,
  runs: (agentId: string, limit: number) => ["tool-runs", agentId, limit] as const,
};

export const tl = {
  connections: () => request<{ items: Connection[] }>("/tool-connections", A).then((r) => r.items),
  createConnection: (b: ConnectionInput) => request<Connection>("/tool-connections", j("POST", b)),
  updateConnection: (id: string, b: Partial<Omit<ConnectionInput, "secret" | "testPath">> & { secret?: string | null; testPath?: string | null }) => request<Connection>(`/tool-connections/${id}`, j("PATCH", b)),
  deleteConnection: (id: string) => request<{ ok: true }>(`/tool-connections/${id}`, j("DELETE")),
  testConnection: (id: string, path?: string) => request<ConnectionTest>(`/tool-connections/${id}/test`, j("POST", path ? { path } : {})),
  testTool: (manifest: unknown, sampleValues: Record<string, unknown>) => request<ToolTestResult>("/tools/test", j("POST", { manifest, sampleValues })),
  runs: (agentId: string, limit = 20) => request<{ items: ToolRun[] }>(`/agents/${agentId}/tool-runs?limit=${limit}`, A).then((r) => r.items),
};

/** Last connection test per connection, kept for this browser session (the API does not store test results). */
const results = new Map<string, { at: number; result: ConnectionTest }>();
const listeners = new Set<() => void>();
export const rememberConnectionTest = (id: string, result: ConnectionTest) => { results.set(id, { at: Date.now(), result }); listeners.forEach((l) => l()); };
const snap = () => results;
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** The Map instance never changes identity, so snapshot by a version counter. */
let version = 0;
listeners.add(() => { version++; });
export function useConnectionTests(): ReadonlyMap<string, { at: number; result: ConnectionTest }> {
  useSyncExternalStore(sub, () => version);
  return snap();
}
