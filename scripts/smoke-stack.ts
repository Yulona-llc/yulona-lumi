#!/usr/bin/env bun
/**
 * End-to-end smoke test against a RUNNING stack (deploy/docker-compose.yml). Verifies: /readyz, login, agent create+publish,
 * widget create, widget bundle served, public widget conversation, worker produced an AI answer (mock provider), and the
 * selfhosted gating (no signup, no billing, no super-admin).
 *   BASE_URL=https://localhost ADMIN_EMAIL=... ADMIN_PASSWORD=... bun scripts/smoke-stack.ts
 * (self-signed local CA: sets NODE_TLS_REJECT_UNAUTHORIZED=0 when BASE_URL is https://localhost)
 */
const base = (process.env.BASE_URL ?? "https://localhost").replace(/\/+$/, "");
if (new URL(base).hostname === "localhost") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
if (!email || !password) { console.error("set ADMIN_EMAIL and ADMIN_PASSWORD"); process.exit(2); }
const origin = new URL(base).origin;
let failed = 0;
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  const t = performance.now();
  try { const r = await fn(); console.log(`ok   ${name} (${Math.round(performance.now() - t)} ms)`); return r; }
  catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
};
const must = (c: unknown, m: string) => { if (!c) throw new Error(m); };
async function j(path: string, init: RequestInit & { token?: string; widgetKey?: string } = {}) {
  const h: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}), Origin: origin };
  if (init.token) h.authorization = `Bearer ${init.token}`;
  if (init.widgetKey) h["x-widget-key"] = init.widgetKey;
  const r = await fetch(base + path, { ...init, headers: { ...h, ...(init.headers as object) } });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}

await step("GET /readyz", async () => { const r = await j("/readyz"); must(r.status === 200, `status ${r.status}`); });
const login = await step("login", async () => {
  const r = await j("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  must(r.status === 200 && r.body.accessToken, `status ${r.status} ${JSON.stringify(r.body)}`); return r.body;
});
const token = login?.accessToken as string;
await step("signup closed (selfhosted)", async () => {
  const r = await j("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ email: "x@example.com", password: "a-very-long-pass-1", name: "x", workspaceName: "x" }) });
  must(r.status === 403, `status ${r.status}`);
});
await step("billing + super-admin routes absent (404)", async () => {
  const a = await j("/api/v1/billing", { token }); const b = await j("/api/v1/admin/tenants", { token });
  must(a.status === 404 && b.status === 404, `billing ${a.status}, admin ${b.status}`);
});
const agent = await step("create + publish agent", async () => {
  const c = await j("/api/v1/agents", { method: "POST", token, body: JSON.stringify({ name: "Support", config: { systemPrompt: "You are a helpful support agent." } }) });
  must(c.status === 201, `create ${c.status} ${JSON.stringify(c.body)}`);
  const p = await j(`/api/v1/agents/${c.body.id}/publish`, { method: "POST", token, body: JSON.stringify({}) });
  must(p.status === 200 || p.status === 201, `publish ${p.status} ${JSON.stringify(p.body)}`); return c.body;
});
await step("add knowledge text (ingest job via worker)", async () => {
  const r = await j("/api/v1/knowledge/sources/text", { method: "POST", token, body: JSON.stringify({ name: "FAQ", text: "Lumi opening hours are 9am to 5pm Monday to Friday. Refunds are processed within 5 business days.", agentId: agent?.id }) });
  must(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  for (let i = 0; i < 30; i++) {
    const s = await j(`/api/v1/knowledge/sources/${r.body.id}`, { token });
    if (s.body.status === "ready") return; must(s.body.status !== "failed", `ingest failed: ${s.body.error}`);
    await Bun.sleep(1000);
  }
  throw new Error("ingestion did not finish in 30s (worker not processing?)");
});
const widget = await step("create widget", async () => {
  const r = await j("/api/v1/widgets", { method: "POST", token, body: JSON.stringify({ name: "Site", agentId: agent?.id, allowedDomains: [new URL(base).hostname, origin] }) });
  must(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`); return r.body;
});
await step("widget bundle served at /widget.js (+ hashed copy)", async () => {
  const r = await fetch(base + "/widget.js"); const t = await r.text();
  must(r.status === 200 && t.length > 10_000, `status ${r.status} len ${t.length}`);
  must((r.headers.get("cache-control") ?? "").includes("max-age=300"), "stable name should be short-cache");
  const v = (await (await fetch(base + "/widget.version")).text()).trim();
  const h = await fetch(`${base}/widget.${v}.js`);
  must(h.status === 200 && (h.headers.get("cache-control") ?? "").includes("immutable"), `hashed copy ${h.status}`);
});
await step("widget preview page framable by dashboard only", async () => {
  const r = await fetch(base + "/widget-preview.html"); must(r.status === 200, `status ${r.status}`);
  must((r.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'self'"), "preview CSP");
  const d = await fetch(base + "/"); must((d.headers.get("x-frame-options") ?? "") === "DENY", "dashboard must stay DENY");
});
const conv = await step("start widget conversation", async () => {
  const r = await j("/api/v1/public/widget/conversations", { method: "POST", widgetKey: widget?.widgetKey, body: JSON.stringify({ visitor: { name: "Visitor", email: "v@example.com" } }) });
  must(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`); return r.body;
});
await step("visitor message -> worker AI reply", async () => {
  const s = await j("/api/v1/public/widget/messages", { method: "POST", widgetKey: widget?.widgetKey, token: conv?.sessionToken, body: JSON.stringify({ text: "What are your opening hours?", clientMessageId: crypto.randomUUID() }) });
  must(s.status === 201, `send ${s.status} ${JSON.stringify(s.body)}`);
  for (let i = 0; i < 30; i++) {
    const m = await j("/api/v1/public/widget/messages", { widgetKey: widget?.widgetKey, token: conv?.sessionToken });
    const ai = (m.body.items ?? []).find((x: any) => x.sender === "ai" || x.role === "ai" || x.senderType === "ai");
    if (ai) { console.log(`     ai reply: ${String(ai.content ?? ai.text).slice(0, 80)}`); return; }
    await Bun.sleep(1000);
  }
  throw new Error("no AI message within 30s");
});
console.log(failed ? `\n${failed} step(s) FAILED` : "\nall steps passed");
process.exit(failed ? 1 : 0);
