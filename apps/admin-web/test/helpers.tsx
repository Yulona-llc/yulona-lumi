import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { setAccessToken, setFetchImpl } from "@/api/client";
import { AuthProvider } from "@/auth/AuthProvider";
import { ThemeProvider } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";
import { App } from "@/App";
import type { Me, Role } from "@/api/types";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
export const apiError = (status: number, code: string, message = code, details?: unknown) => json({ error: { code, message, requestId: "r1", details } }, status);

export interface Call { method: string; path: string; url: string; body: unknown; headers: Record<string, string> }
type Handler = unknown | ((c: Call) => Response | unknown);

export const me = (role: Role = "owner", over: Partial<Me> = {}): Me => ({ id: "a1", email: `${role}@lumi.test`, name: `${role[0]!.toUpperCase()}${role.slice(1)} Person`, role, twoFactorEnabled: false, restricted: null, ...over });

/** Routes are matched as `"METHOD /path"` (or `"/path"` for any method) against the path without query string; the longest key wins. */
export function mockApi(routes: Record<string, Handler>, opts: { role?: Role | null; adminOver?: Partial<Me> } = {}) {
  const calls: Call[] = [];
  const role = opts.role === undefined ? "owner" : opts.role;
  const base: Record<string, Handler> = {
    "POST /auth/refresh": () => (role ? json({ accessToken: "tok", expiresIn: 900, admin: me(role, opts.adminOver) }) : apiError(401, "invalid_refresh_token")),
    "POST /auth/logout": { ok: true },
    "GET /attention": { items: [], total: 0 },
    "GET /health": { status: "ok", db: { ok: true, latencyMs: 2 }, queue: { queued: 0, running: 0, dead: 0, oldestQueuedAgeSec: 0 }, worker: { lastHeartbeatAt: null, ageSec: 1, ok: true } },
  };
  const all = { ...base, ...routes };
  setAccessToken(null);
  setFetchImpl((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = { method, path, url: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const key = Object.keys(all).filter((k) => { const [m, p] = k.includes(" ") ? k.split(" ") : [method, k]; return m === method && (path === p || path.startsWith(p + "/")) && (path === p || k.endsWith("/")); })
      .sort((a, b) => b.length - a.length)[0] ?? Object.keys(all).filter((k) => { const [m, p] = k.includes(" ") ? k.split(" ") : [method, k]; return m === method && path === p; })[0];
    if (!key) return apiError(404, "not_found", `no mock for ${method} ${path}`);
    const h = all[key];
    const r = typeof h === "function" ? (h as (c: Call) => unknown)(call) : h;
    return r instanceof Response ? r : json(r);
  }) as typeof fetch);
  return calls;
}

export function mountApp(initial = "/", routes: Record<string, Handler> = {}, opts: Parameters<typeof mockApi>[1] = {}) {
  const calls = mockApi(routes, opts);
  const ui: ReactElement = (
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[initial]}>
          <AuthProvider><App /><Toaster /></AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
  return { calls, ...render(ui) };
}

const health = (score: number, bucket: "healthy" | "watch" | "at_risk", reasons: Array<{ code: string; label: string; points: number }> = []) => ({ score, bucket, reasons });
export const tenantItem = (over: Record<string, unknown> = {}) => ({
  id: "t1", name: "Acme Corp", status: "active", plan: "pro", createdAt: "2026-01-02T00:00:00Z", deletedAt: null, userCount: 3, ownerEmail: "boss@acme.test",
  lastActiveAt: "2026-10-30T00:00:00Z", errorCount7d: 2, credits: { state: "low", remainingMicro: 4_000_000 }, health: health(62, "watch", [{ code: "failed_webhooks", label: "4 failed webhook deliveries in 7 days", points: 12 }]), tags: ["vip"], ...over,
});
export const tenantDetail = (over: Record<string, unknown> = {}) => ({
  tenant: { id: "t1", name: "Acme Corp", status: "active", plan: "pro", createdAt: "2026-01-02T00:00:00Z", deletedAt: null },
  owner: { email: "boss@acme.test", name: "Bo Boss" }, health: health(62, "watch", [{ code: "failed_webhooks", label: "4 failed webhook deliveries in 7 days", points: 12 }, { code: "inactive", label: "No customer messages for 14+ days", points: 15 }]),
  counts: { users: 3, agents: 2, widgets: 1, channels: 1, contacts: 40, conversations: 90, knowledgeSources: 4 }, lastActivityAt: "2026-10-30T00:00:00Z", errorCount7d: 2,
  limits: [{ metric: "agents", limit: 5, used: 2, warning: false }], billing: null,
  credits: { mode: "managed", enabled: true, unlimited: false, period: "monthly", allowanceMicro: 5_000_000, usedMicro: 1_000_000, topupMicro: 0, topupUsedMicro: 0, remainingMicro: 4_000_000, percentUsed: 20, status: "ok", warnings: [], planKey: "pro" },
  tags: ["vip"], notesCount: 0, ...over,
});
