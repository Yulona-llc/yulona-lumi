#!/usr/bin/env bun
/**
 * Load test (no dependencies: Bun fetch). Scenarios against a RUNNING stack:
 *   read    authenticated API reads   GET /api/v1/me, /conversations, /agents      (needs ADMIN_EMAIL/ADMIN_PASSWORD)
 *   widget  visitor flow              POST /public/widget/conversations then POST /messages (needs WIDGET_KEY, or set ADMIN_* to auto-create one)
 * Usage: BASE_URL=https://localhost ADMIN_EMAIL=.. ADMIN_PASSWORD=.. bun scripts/load-test.ts [--scenario read|widget|all] [--duration 15] [--concurrency 20]
 * NOTE: the API's built-in rate limits (300 req/min/IP global, per-widget limits) are ACTIVE and 429s are counted separately:
 * a load generator on one IP measures the limiter as much as the app. Treat 2xx latency as the signal; see docs/self-hosting.md.
 */
import { parseArgs } from "node:util";
const { values: a } = parseArgs({ options: { scenario: { type: "string", default: "all" }, duration: { type: "string", default: "15" }, concurrency: { type: "string", default: "20" } } });
const base = (process.env.BASE_URL ?? "https://localhost").replace(/\/+$/, "");
if (new URL(base).hostname === "localhost") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const origin = new URL(base).origin;
const duration = Number(a.duration) * 1000, conc = Number(a.concurrency);

async function api(path: string, init: RequestInit & { token?: string; key?: string } = {}) {
  const h: Record<string, string> = { Origin: origin, ...(init.body ? { "content-type": "application/json" } : {}) };
  if (init.token) h.authorization = `Bearer ${init.token}`;
  if (init.key) h["x-widget-key"] = init.key;
  return fetch(base + path, { ...init, headers: h });
}
let token = "", widgetKey = process.env.WIDGET_KEY ?? "";
if (process.env.ADMIN_EMAIL) {
  const r = await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
  token = ((await r.json()) as any).accessToken ?? "";
  if (token && !widgetKey) {
    const w = await api("/api/v1/widgets", { method: "POST", token, body: JSON.stringify({ name: "load", allowedDomains: [new URL(base).hostname, origin] }) });
    widgetKey = ((await w.json()) as any).widgetKey ?? "";
  }
}

interface Stat { lat: number[]; status: Map<number, number>; errors: number }
async function run(name: string, once: () => Promise<number>) {
  const st: Stat = { lat: [], status: new Map(), errors: 0 };
  const end = Date.now() + duration;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      const t = performance.now();
      try { const s = await once(); st.lat.push(performance.now() - t); st.status.set(s, (st.status.get(s) ?? 0) + 1); }
      catch { st.errors++; }
    }
  }));
  const ok = st.lat.length, sorted = [...st.lat].sort((x, y) => x - y);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(1) : "-");
  const two = [...st.status].filter(([s]) => s < 300).reduce((n, [, c]) => n + c, 0);
  console.log(`${name.padEnd(22)} reqs=${ok} (${(ok / (duration / 1000)).toFixed(0)}/s) 2xx=${two} 429=${st.status.get(429) ?? 0} other=${ok - two - (st.status.get(429) ?? 0)} neterr=${st.errors} p50=${q(0.5)}ms p95=${q(0.95)}ms p99=${q(0.99)}ms`);
}
const want = (s: string) => a.scenario === "all" || a.scenario === s;
console.log(`target=${base} duration=${a.duration}s concurrency=${conc}`);
if (want("read")) {
  if (!token) console.log("skip read: set ADMIN_EMAIL/ADMIN_PASSWORD");
  else {
    await run("GET /healthz", async () => (await api("/healthz")).status);
    const paths = ["/api/v1/me", "/api/v1/conversations?limit=20", "/api/v1/agents"]; let i = 0;
    await run("authed reads (mixed)", async () => { const r = await api(paths[i++ % paths.length]!, { token }); await r.arrayBuffer(); return r.status; });
  }
}
if (want("widget")) {
  if (!widgetKey) console.log("skip widget: set WIDGET_KEY or ADMIN_*");
  else {
    await run("widget conv start", async () => { const r = await api("/api/v1/public/widget/conversations", { method: "POST", key: widgetKey, body: JSON.stringify({ visitor: { name: "L" } }) }); await r.arrayBuffer(); return r.status; });
    const c = await (await api("/api/v1/public/widget/conversations", { method: "POST", key: widgetKey, body: "{}" })).json() as any;
    if (c.sessionToken) await run("widget send message", async () => {
      const r = await api("/api/v1/public/widget/messages", { method: "POST", key: widgetKey, token: c.sessionToken, body: JSON.stringify({ text: "hello", clientMessageId: crypto.randomUUID() }) });
      await r.arrayBuffer(); return r.status;
    });
  }
}
