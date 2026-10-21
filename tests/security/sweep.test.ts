import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedAll, snapshot, type Fixtures } from "./fixtures";
import { api, boot, docsAuth, hasDb, mkTenant, type Booted } from "../support";

/**
 * Cross-tenant sweep over EVERY registered route (Hono route table, cross-checked against docs/openapi.json).
 *  1. unauthenticated => 401 (or the documented alternative for allow-listed non-JWT realms)
 *  2. super-admin routes reject tenant tokens
 *  3. tenant B + tenant A's ids => never 2xx, A's rows byte-identical afterwards, no A markers in B's responses
 *  4. API-key realm: B's key + A's ids => same guarantees
 * A route that is neither covered (fixture for its :params) nor allow-listed with a reason FAILS the test.
 */
interface Allow { re: RegExp; reason: string; unauth: number[] }
const PUBLIC: Allow[] = [
  { re: /^GET \/(healthz|readyz)$/, reason: "liveness/readiness probes", unauth: [200] },
  { re: /^GET \/(docs|docs\/|api\/v1\/openapi\.json)$/, reason: "HTTP basic auth realm (DOCS_PASSWORD), not JWT", unauth: [401, 301] },
  { re: /^POST \/api\/v1\/auth\/(register|login)$/, reason: "credential endpoints; rate limited", unauth: [400] },
  { re: /^POST \/api\/v1\/auth\/(refresh|logout)$/, reason: "refresh-cookie + CSRF header realm", unauth: [401, 403] },
  { re: /^GET \/api\/v1\/auth\/csrf$/, reason: "issues double-submit CSRF token", unauth: [200] },
  { re: /^POST \/api\/v1\/admin\/auth\/login$/, reason: "super-admin credential endpoint", unauth: [400] },
  { re: /^POST \/api\/v1\/invitations\/accept$/, reason: "invitation-token realm", unauth: [400] },
  { re: /^GET \/api\/v1\/calendar\/google\/callback$/, reason: "OAuth callback authenticated by HMAC-signed state (invalid state => redirect to dashboard with error)", unauth: [302, 400, 401, 403] },
  { re: /^GET \/api\/v1\/calendar\/calendly\/callback$/, reason: "Calendly OAuth callback authenticated by HMAC-signed state + PKCE (invalid state => redirect to dashboard with error)", unauth: [302, 400, 401, 403] },
  { re: /^GET \/api\/v1\/realtime\/ws$/, reason: "WebSocket: token is sent in the first frame (closed 4401 otherwise, see conversations.test); plain GET => 426", unauth: [426] },
  { re: /^(GET|POST|OPTIONS) (\/api\/v1)?\/public\/widget\//, reason: "widget-key + origin allowlist + session JWT realm", unauth: [400, 401, 403] },
  { re: /^(GET|POST|PATCH) \/api\/v1\/(public-api\/|key-info$)/, reason: "API-key realm (Bearer yl_...)", unauth: [401] },
  { re: /^(GET|POST) \/api\/v1\/webhooks\/channels\/:channel\/:connectionId$/, reason: "provider webhook, signature verified", unauth: [400, 401, 403, 404] },
  { re: /^POST \/api\/v1\/webhooks\/(billing|transactions\/:endpointId)$/, reason: "provider/HMAC webhook, signature verified (billing: stub provider is accepted only outside production; see misc.test)", unauth: [200, 400, 401, 403, 404] },
];
const publicRule = (sig: string) => PUBLIC.find((p) => p.re.test(sig));

/** body used for mutating requests (default `{}`; validation errors still must not succeed) */
const BODIES: Record<string, (f: Fixtures) => unknown> = {
  "PATCH /api/v1/contacts/:id": () => ({ name: "hacked" }),
  "POST /api/v1/contacts/:id/merge": (f) => ({ sourceContactId: f.ids.contacts2 }),
  "PATCH /api/v1/conversations/:id": () => ({ status: "resolved" }),
  "POST /api/v1/conversations/:id/messages": () => ({ text: "hacked" }),
  "PATCH /api/v1/agents/:id": () => ({ name: "hacked" }),
  "PATCH /api/v1/widgets/:id": () => ({ name: "hacked" }),
  "PATCH /api/v1/tickets/:id": () => ({ title: "hacked" }),
  "POST /api/v1/tickets/:id/comments": () => ({ body: "hacked", text: "hacked" }),
  "PATCH /api/v1/transactions/:id": () => ({ description: "hacked" }),
  "PATCH /api/v1/canned-responses/:id": () => ({ title: "hacked" }),
  "PATCH /api/v1/tags/:id": () => ({ name: "hacked" }),
  "PATCH /api/v1/webhooks/:id": () => ({ name: "hacked" }),
  "PATCH /api/v1/tool-connections/:id": () => ({ name: "hacked" }),
  "PATCH /api/v1/users/:id": () => ({ role: "viewer" }),
  "PATCH /api/v1/channels/connections/:id": () => ({ name: "hacked" }),
  "PATCH /api/v1/transactions/webhook-endpoints/:id": () => ({ name: "hacked" }),
  "POST /api/v1/agent-builder/sessions/:id/messages": () => ({ text: "hacked" }),
  "POST /api/v1/bookings/:id/cancel": () => ({}),
  "POST /api/v1/needs-attention/:id/assign": (f) => ({ userId: f.tenant.userId }),
  "POST /api/v1/needs-attention/:id/resolve": () => ({ note: "hacked" }),
  "POST /api/v1/agents/:id/rollback": () => ({ version: 1 }),
  "PUT /api/v1/contacts/:id/tags": (f) => ({ tagIds: [f.ids.tags] }),
  "PUT /api/v1/conversations/:id/tags": (f) => ({ tagIds: [f.ids.tags] }),
  "PUT /api/v1/tickets/:id/tags": (f) => ({ tagIds: [f.ids.tags] }),
  "PATCH /api/v1/public-api/contacts/:id": () => ({ name: "hacked" }),
  "POST /api/v1/public-api/conversations/:id/messages": () => ({ text: "hacked" }),
};

const PARAM_KEY: Record<string, string> = {
  agents: "agents", "api-keys": "api-keys", "canned-responses": "canned-responses", connections: "connections", contacts: "contacts",
  invitations: "invitations", sources: "sources", tags: "tags", tickets: "tickets", transactions: "transactions",
  "webhook-endpoints": "webhook-endpoints", webhooks: "webhooks", widgets: "widgets", bookings: "bookings", conversations: "conversations",
  requests: "requests", "needs-attention": "needs-attention", notifications: "notifications", "webhook-deliveries": "webhook-deliveries",
  users: "users", "merge-suggestions": "merge-suggestions", "tool-connections": "tool-connections", sessions: "sessions",
};
function fill(path: string, f: Fixtures): string | null {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.startsWith(":")) { out.push(p); continue; }
    const key = PARAM_KEY[parts[i - 1] ?? ""];
    const val = key ? f.ids[key] : undefined;
    if (!val) return null;
    out.push(val);
  }
  return out.join("/");
}

describe.skipIf(!hasDb)("cross-tenant sweep", () => {
  let b: Booted, A: Fixtures, B: Fixtures;
  let routes: { method: string; path: string; sig: string }[] = [];
  beforeAll(async () => {
    b = await boot();
    A = await seedAll(b, "a");
    B = await seedAll(b, "b");
    const seen = new Map<string, { method: string; path: string; sig: string }>();
    for (const r of b.app.routes) {
      if (r.method === "ALL") continue;
      const sig = `${r.method} ${r.path}`;
      seen.set(sig, { method: r.method, path: r.path, sig });
    }
    routes = [...seen.values()];
  });
  afterAll(async () => b.close());

  const req = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    api(b, method, path, h, ["POST", "PATCH", "PUT"].includes(method) ? (body ?? {}) : undefined);

  test("route table is non-trivial and every OpenAPI path exists as a route (spec drift check)", async () => {
    expect(routes.length).toBeGreaterThan(200);
    const doc = await (await b.app.request("/api/v1/openapi.json", { headers: docsAuth() })).json() as { paths: Record<string, Record<string, unknown>> };
    const have = new Set(routes.map((r) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, "{$1}")}`));
    // the spec documents /{resource}/{id}/tags once; the router registers it per resource
    for (const res of ["conversations", "contacts", "tickets"]) for (const m of ["GET", "PUT"]) if (have.has(`${m} /api/v1/${res}/{id}/tags`)) have.add(`${m} /api/v1/{resource}/{id}/tags`);
    const missing: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) for (const m of Object.keys(ops)) {
      const sig = `${m.toUpperCase()} ${p}`;
      if (!have.has(sig)) missing.push(sig);
    }
    expect(missing).toEqual([]);
  });

  test("1. unauthenticated requests: every non-allow-listed route is 401; allow-listed ones answer per their realm", async () => {
    const failures: string[] = [];
    let protectedCount = 0, allowCount = 0;
    for (const r of routes) {
      const url = (fill(r.path, A) ?? r.path.replace(/:[A-Za-z]+/g, crypto.randomUUID())).replace(/^\//, "/");
      const allow = publicRule(r.sig);
      const res = await req(r.method, url, r.path.startsWith("/docs") || r.path.endsWith("openapi.json") ? {} : {}, undefined);
      if (allow) { allowCount++; if (!allow.unauth.includes(res.status)) failures.push(`${r.sig} (allow-listed: ${allow.reason}) -> ${res.status}, expected ${allow.unauth}`); continue; }
      protectedCount++;
      if (res.status !== 401) failures.push(`${r.sig} unauthenticated -> ${res.status}`);
      // a garbage bearer must be 401 too
      const g = await req(r.method, url, { authorization: "Bearer not.a.jwt" });
      if (g.status !== 401) failures.push(`${r.sig} garbage bearer -> ${g.status}`);
    }
    expect(failures).toEqual([]);
    expect(protectedCount).toBeGreaterThan(150);
    expect(allowCount).toBeGreaterThan(20);
  });

  test("2. super-admin routes reject tenant tokens (owner included)", async () => {
    const failures: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith("/api/v1/admin/") && !publicRule(x.sig))) {
      const url = r.path.replace(/:[A-Za-z]+/g, crypto.randomUUID());
      const res = await req(r.method, url, A.tenant.h);
      if (![401, 403].includes(res.status)) failures.push(`${r.sig} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  test("3. tenant B cannot read or modify tenant A's resources (JWT realm)", async () => {
    const before = await snapshot(b, A.tenant.tenantId);
    const uncovered: string[] = [], failures: string[] = [], weak: string[] = [];
    let attacked = 0;
    for (const r of routes) {
      if (publicRule(r.sig) || r.path.startsWith("/api/v1/admin/")) continue;
      if (!r.path.includes(":")) continue; // id-less routes are covered by the leak scan below
      const url = fill(r.path, A);
      if (!url) { uncovered.push(r.sig); continue; }
      const body = BODIES[r.sig]?.(A);
      const res = await req(r.method, url, B.tenant.h, body);
      attacked++;
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) failures.push(`${r.sig} ${url} as B -> ${res.status}`);
      if (res.status >= 500) failures.push(`${r.sig} as B -> ${res.status} (server error)`);
      if (text.includes(A.mark) || text.includes(A.tenant.tenantId)) failures.push(`${r.sig} as B leaked tenant A data`);
      if (res.status === 400 && !BODIES[r.sig] && ["POST", "PATCH", "PUT"].includes(r.method)) weak.push(r.sig);
    }
    expect(uncovered).toEqual([]);
    expect(failures).toEqual([]);
    expect(attacked).toBeGreaterThan(60);
    const after = await snapshot(b, A.tenant.tenantId);
    expect(after).toEqual(before);
    console.log(`sweep(JWT): ${attacked} id-routes attacked; mutating routes answered 400 with a default body (status proves less, DB snapshot still proves no change): ${weak.length}`);
  });

  test("3a. positive control: the same GET :id routes DO return 200 for the owning tenant (fixtures are real, so B's refusals are meaningful)", async () => {
    let ok = 0; const bad: string[] = [];
    for (const r of routes) {
      if (r.method !== "GET" || !r.path.includes(":") || publicRule(r.sig) || r.path.startsWith("/api/v1/admin/") || r.path.startsWith("/api/v1/public-api/")) continue;
      const url = fill(r.path, A);
      if (!url) continue;
      const res = await req("GET", url, A.tenant.h);
      if (res.status === 200) ok++; else bad.push(`${r.sig} -> ${res.status}`);
    }
    console.log(`positive control: ${ok} GET id-routes 200 for owner; non-200: ${bad.join(", ")}`);
    expect(ok).toBeGreaterThan(18);
  });

  test("3b. id-less GET routes never include tenant A's data for tenant B; A sees its own (positive control)", async () => {
    const leaks: string[] = [], empty: string[] = [];
    let n = 0;
    for (const r of routes) {
      if (r.method !== "GET" || r.path.includes(":") || publicRule(r.sig) || r.path.startsWith("/api/v1/admin/") || r.path.endsWith("/ws") || r.path.endsWith("/stream")) continue;
      const rb = await req("GET", r.path, B.tenant.h);
      const t = await rb.text();
      n++;
      if (t.includes(A.mark) || t.includes(A.tenant.tenantId) || t.includes(A.tenant.userId)) leaks.push(r.sig);
      if (["/api/v1/contacts", "/api/v1/agents", "/api/v1/conversations", "/api/v1/tickets", "/api/v1/widgets"].includes(r.path)) {
        const ra = await (await req("GET", r.path, A.tenant.h)).text();
        if (!ra.includes(A.mark)) empty.push(r.sig);
      }
    }
    expect(leaks).toEqual([]);
    expect(empty).toEqual([]);
    expect(n).toBeGreaterThan(30);
  });

  test("4. API-key realm: B's key with A's ids is refused; A's key still works (control)", async () => {
    const before = await snapshot(b, A.tenant.tenantId);
    const failures: string[] = [];
    const keyed = routes.filter((r) => r.path.startsWith("/api/v1/public-api/"));
    expect(keyed.length).toBeGreaterThan(10);
    for (const r of keyed) {
      const urlA = fill(r.path, A);
      if (!urlA) { failures.push(`no fixture for ${r.sig}`); continue; }
      const body = BODIES[r.sig]?.(A);
      const res = await req(r.method, urlA, { authorization: `Bearer ${B.apiKey}` }, body);
      const text = await res.text();
      if (r.path.includes(":") && res.status >= 200 && res.status < 300) failures.push(`${r.sig} with B's key -> ${res.status}`);
      if (res.status >= 500) failures.push(`${r.sig} -> ${res.status}`);
      if (text.includes(A.mark) || text.includes(A.tenant.tenantId)) failures.push(`${r.sig} leaked A data to B's key`);
    }
    expect(failures).toEqual([]);
    expect(await snapshot(b, A.tenant.tenantId)).toEqual(before);
    const ok = await req("GET", `/api/v1/public-api/contacts/${A.ids.contacts}`, { authorization: `Bearer ${A.apiKey}` });
    expect(ok.status).toBe(200);
    expect((await req("GET", `/api/v1/public-api/contacts/${A.ids.contacts}`, { authorization: `Bearer ${B.apiKey}` })).status).toBe(404);
  });

  test("5. cross-tenant references inside request bodies are rejected (B creates/links using A's ids)", async () => {
    const before = await snapshot(b, A.tenant.tenantId);
    const h = B.tenant.h;
    const attempts: [string, string, unknown][] = [
      ["POST", "/tickets", { title: "x", contactId: A.ids.contacts }],
      ["POST", "/tickets", { title: "x", conversationId: A.ids.conversations }],
      ["POST", "/tickets", { title: "x", assigneeUserId: A.tenant.userId }],
      ["PATCH", `/tickets/${B.ids.tickets}`, { assigneeUserId: A.tenant.userId }],
      ["PATCH", `/conversations/${B.ids.conversations}`, { assignedUserId: A.tenant.userId }],
      ["POST", "/bookings", { title: "x", startAt: new Date(Date.now() + 864e5).toISOString(), endAt: new Date(Date.now() + 864e5 + 36e5).toISOString(), contactId: A.ids.contacts }],
      ["POST", `/contacts/${B.ids.contacts}/merge`, { sourceContactId: A.ids.contacts }],
      ["PUT", `/contacts/${B.ids.contacts}/tags`, { tagIds: [A.ids.tags] }],
      ["POST", "/transactions", { amountCents: 100, currency: "USD", contactId: A.ids.contacts }],
      ["POST", "/knowledge/sources/text", { name: "x", text: "hello world", agentId: A.ids.agents }],
      ["POST", "/knowledge/sandbox", { agentId: A.ids.agents, message: "hi" }],
      ["POST", `/needs-attention/${B.ids["needs-attention"]}/assign`, { userId: A.tenant.userId }],
    ];
    const bad: string[] = [];
    for (const [m, p, body] of attempts) {
      const r = await req(m, p, h, body);
      if (r.status >= 200 && r.status < 300) bad.push(`${m} ${p} ${JSON.stringify(body)} -> ${r.status}`);
      if (r.status >= 500) bad.push(`${m} ${p} -> ${r.status}`);
    }
    expect(bad).toEqual([]);
    expect(await snapshot(b, A.tenant.tenantId)).toEqual(before);
    // B must not have acquired rows pointing at A's contact/conversation
    const refs = await b.owner`SELECT count(*)::int AS n FROM tickets WHERE tenant_id = ${B.tenant.tenantId} AND (contact_id = ${A.ids.contacts!} OR conversation_id = ${A.ids.conversations!})`;
    expect(refs[0]!.n).toBe(0);
  });

  test("7. role matrix: a viewer token never succeeds on a mutating route (except own-state allow-list); an agent never reaches admin-only config", async () => {
    const viewer = await mkTenant(b, "view", "viewer", A.tenant.tenantId);
    const agent = await mkTenant(b, "agt", "agent", A.tenant.tenantId);
    const ownState = /^(PUT \/api\/v1\/availability\/me|POST \/api\/v1\/notifications\/(read-all|:id\/read)|PUT \/api\/v1\/notifications\/preferences|POST \/api\/v1\/knowledge\/sandbox|POST \/api\/v1\/auth\/.*)$/;
    const viewerOk: string[] = [], agentAdmin: string[] = [];
    const adminOnly = [/^POST \/api\/v1\/(api-keys|invitations|webhooks|channels\/connections|widgets|agents)$/, /^(PATCH|DELETE) \/api\/v1\/(users|api-keys|webhooks|agents|widgets|channels\/connections)\/:id$/, /^PUT \/api\/v1\/(retention|ops\/settings)$/, /^POST \/api\/v1\/gdpr\//, /^POST \/api\/v1\/billing\/(checkout|portal|cancel)$/, /^PATCH \/api\/v1\/tenant$/];
    for (const r of routes) {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(r.method) || publicRule(r.sig) || r.path.startsWith("/api/v1/admin/") || r.path.startsWith("/api/v1/public-api/") || ownState.test(r.sig)) continue;
      const url = fill(r.path, A) ?? r.path.replace(/:[A-Za-z]+/g, crypto.randomUUID());
      const body = BODIES[r.sig]?.(A);
      const rv = await req(r.method, url, viewer.h, body);
      if (rv.status >= 200 && rv.status < 300) viewerOk.push(`${r.sig} -> ${rv.status}`);
      if (adminOnly.some((a) => a.test(r.sig))) {
        const ra = await req(r.method, url, agent.h, body);
        if (ra.status >= 200 && ra.status < 300) agentAdmin.push(`${r.sig} -> ${ra.status}`);
      }
    }
    expect(viewerOk).toEqual([]);
    expect(agentAdmin).toEqual([]);
  });

  test("8. suspended tenant: existing access tokens stop working", async () => {
    const S = await mkTenant(b, "susp");
    expect((await req("GET", "/api/v1/me", S.h)).status).toBe(200);
    await b.owner`UPDATE tenants SET status = 'suspended' WHERE id = ${S.tenantId}`;
    expect([401, 403]).toContain((await req("GET", "/api/v1/contacts", S.h)).status);
  });

  test("8b. suspended tenant: API keys, widget sessions and the public widget config stop working too", async () => {
    const S = await seedAll(b, "sp");
    const w = await (await req("POST", "/api/v1/widgets", S.tenant.h, { name: "W", allowedDomains: ["https://shop.example.test"] })).json() as { widgetKey: string };
    const wh = { "x-widget-key": w.widgetKey, origin: "https://shop.example.test" };
    const conv = await (await req("POST", "/api/v1/public/widget/conversations", wh, { visitor: { email: "v@example.test" } })).json() as { sessionToken: string };
    expect((await req("GET", "/api/v1/public-api/contacts", { authorization: `Bearer ${S.apiKey}` })).status).toBe(200);
    expect((await req("GET", "/api/v1/public/widget/messages", { ...wh, authorization: `Bearer ${conv.sessionToken}` })).status).toBe(200);
    await b.owner`UPDATE tenants SET status = 'suspended' WHERE id = ${S.tenant.tenantId}`;
    expect([401, 403]).toContain((await req("GET", "/api/v1/public-api/contacts", { authorization: `Bearer ${S.apiKey}` })).status);
    expect([401, 403, 404]).toContain((await req("GET", "/api/v1/public/widget/config", wh)).status);
    expect([401, 403, 404]).toContain((await req("GET", "/api/v1/public/widget/messages", { ...wh, authorization: `Bearer ${conv.sessionToken}` })).status);
    expect([401, 403, 404]).toContain((await req("POST", "/api/v1/public/widget/conversations", wh, { visitor: { email: "w@example.test" } })).status);
  });

  test("6. a tenant JWT cannot be re-pointed: tenantId in query/body/headers is rejected or ignored", async () => {
    const r1 = await req("GET", `/api/v1/contacts?tenantId=${A.tenant.tenantId}`, B.tenant.h);
    expect(r1.status).toBe(400);
    const r2 = await req("POST", "/tags", B.tenant.h, { name: "x", tenantId: A.tenant.tenantId });
    expect(r2.status).toBe(400);
    const r3 = await req("GET", "/api/v1/contacts", { ...B.tenant.h, "x-tenant-id": A.tenant.tenantId });
    expect(await r3.text()).not.toContain(A.mark);
    const un = await mkTenant(b, "forge");
    // forged signature with a different secret
    const forged = await (await import("../../apps/api/src/security")).signAccessToken("x".repeat(40), { userId: un.userId, tenantId: A.tenant.tenantId, role: "owner", ttlSeconds: 900 });
    expect((await req("GET", "/api/v1/me", { authorization: `Bearer ${forged}` })).status).toBe(401);
  });
});
