import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const KEY = Buffer.alloc(32, 9).toString("base64");
const PUBLIC = async () => ["93.184.216.34"];

describe.skipIf(!hasDb)("tool connections + /tools/test", () => {
  let app: ReturnType<typeof createApp>;
  let appNoKey: ReturnType<typeof createApp>;
  let saas: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let backend: ReturnType<typeof Bun.serve>;
  const seen: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];

  const hdr = async (t: { tenantId: string; userId: string }, role: "owner" | "admin" | "agent" | "viewer" = "owner") =>
    ({ authorization: `Bearer ${await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 })}`, "content-type": "application/json" });
  const call = (a: ReturnType<typeof createApp>, method: string, path: string, h: Record<string, string>, body?: unknown) =>
    a.request(`/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({ method: req.method, path: u.pathname + u.search, headers: Object.fromEntries(req.headers), body: await req.text() });
        if (u.pathname === "/boom") return new Response("fail", { status: 500 });
        if (u.pathname === "/health") return Response.json({ status: "ok" });
        return Response.json({ status: "shipped", total: 12.5, customer: { email: "a@b.c" }, lines: [{ sku: "A", qty: 1 }, { sku: "B", qty: 2 }] });
      },
    });
    const s = await setupTestDb();
    owner = s.owner;
    const mk = (mode: "saas" | "selfhosted", key: string | undefined) => {
      const cfg = testConfig({ DEPLOYMENT_MODE: mode, ...(key ? { ENCRYPTION_KEY: key } : {}) }, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; });
      const fetchImpl = ((input: URL | string, init?: RequestInit) => {
        const u = new URL(String(input));
        return fetch(`http://127.0.0.1:${backend.port}${u.pathname}${u.search}`, init);
      }) as unknown as typeof fetch;
      return createApp({ cfg, db: s.app, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent" }), tools: { fetchImpl, resolver: PUBLIC } });
    };
    app = mk("selfhosted", KEY);
    appNoKey = mk("selfhosted", undefined);
    saas = mk("saas", KEY);
  });
  afterAll(() => backend.stop(true));

  const mkConn = async (a: ReturnType<typeof createApp>, t: { tenantId: string; userId: string }, over: Record<string, unknown> = {}) =>
    call(a, "POST", "/tool-connections", await hdr(t), { name: `c-${crypto.randomUUID().slice(0, 6)}`, baseUrl: "https://shop.test", authType: "bearer", secret: "tok_PLAINTEXT_123", ...over });

  test("create/list/get/patch/delete; secrets are write-only and encrypted at rest; audited", async () => {
    const A = await seedTenantWithUser(owner, "tc-A");
    const res = await mkConn(app, A, { name: "Orders", testPath: "/health" });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as Record<string, unknown>;
    expect(dto).toMatchObject({ name: "Orders", kind: "http", baseUrl: "https://shop.test", authType: "bearer", hasSecret: true, testPath: "/health" });
    expect(JSON.stringify(dto)).not.toContain("tok_PLAINTEXT_123");
    expect(dto.secret).toBeUndefined();
    expect(dto.secretEncrypted).toBeUndefined();
    const id = dto.id as string;

    const [row] = await owner<{ secret_encrypted: string }[]>`SELECT secret_encrypted FROM tool_connections WHERE id = ${id}`;
    expect(row!.secret_encrypted.startsWith("v1.")).toBe(true);
    expect(row!.secret_encrypted).not.toContain("tok_PLAINTEXT_123");

    const list = (await (await call(app, "GET", "/tool-connections", await hdr(A))).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([id]);
    expect(JSON.stringify(list)).not.toContain("tok_PLAINTEXT_123");
    expect((await call(app, "GET", `/tool-connections/${id}`, await hdr(A))).status).toBe(200);

    // rotate secret + change type to api_key (header defaults to X-API-Key)
    const p = await call(app, "PATCH", `/tool-connections/${id}`, await hdr(A), { authType: "api_key", secret: "key_NEW_456" });
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ authType: "api_key", authHeaderName: "X-API-Key", hasSecret: true });
    const [row2] = await owner<{ secret_encrypted: string }[]>`SELECT secret_encrypted FROM tool_connections WHERE id = ${id}`;
    expect(row2!.secret_encrypted).not.toBe(row!.secret_encrypted);
    // rename keeps the stored secret
    expect(await (await call(app, "PATCH", `/tool-connections/${id}`, await hdr(A), { name: "Orders v2" })).json()).toMatchObject({ name: "Orders v2", hasSecret: true });
    // cannot drop the secret while the auth type needs one; none + null clears it
    expect((await call(app, "PATCH", `/tool-connections/${id}`, await hdr(A), { secret: null })).status).toBe(400);
    expect(await (await call(app, "PATCH", `/tool-connections/${id}`, await hdr(A), { authType: "none", secret: null })).json()).toMatchObject({ authType: "none", hasSecret: false });

    expect((await call(app, "DELETE", `/tool-connections/${id}`, await hdr(A))).status).toBe(200);
    expect((await call(app, "GET", `/tool-connections/${id}`, await hdr(A))).status).toBe(404);

    const acts = await owner<{ action: string; metadata: unknown }[]>`SELECT action, metadata FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action LIKE 'tool_connection.%' ORDER BY created_at`;
    expect(acts.map((a) => a.action)).toEqual(["tool_connection.create", "tool_connection.update", "tool_connection.update", "tool_connection.update", "tool_connection.delete"]);
    expect(JSON.stringify(acts)).not.toContain("tok_PLAINTEXT_123");
    expect(JSON.stringify(acts)).not.toContain("key_NEW_456");
  });

  test("validation: auth/secret rules, https in SaaS, no private hosts, strict bodies, duplicate names", async () => {
    const A = await seedTenantWithUser(owner, "tc-val");
    const bad = async (a: ReturnType<typeof createApp>, over: Record<string, unknown>) => (await mkConn(a, A, over)).status;
    expect(await bad(app, { secret: undefined })).toBe(400); // bearer needs a secret
    expect(await bad(app, { authType: "none" })).toBe(400); // none must not carry a secret
    expect(await bad(app, { authType: "basic", secret: "nocolon" })).toBe(400);
    expect(await bad(app, { authType: "none", secret: undefined, authHeaderName: "X-A" })).toBe(201); // ignored for none
    expect(await bad(app, { baseUrl: "ftp://x.test" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://user:pw@shop.test" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://shop.test/?a=1" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://127.0.0.1" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://169.254.169.254/latest" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://localhost:8080" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://10.1.2.3" })).toBe(400);
    expect(await bad(app, { baseUrl: "https://[::1]/" })).toBe(400);
    expect(await bad(app, { surprise: 1 })).toBe(400);
    expect(await bad(app, { testPath: "//evil.test" })).toBe(400);
    // http: allowed self-hosted, refused in SaaS
    expect(await bad(app, { baseUrl: "http://erp.example.com" })).toBe(201);
    expect(await bad(saas, { baseUrl: "http://erp.example.com" })).toBe(400);
    // unique name
    const dup = { name: "dup-name" };
    expect(await bad(app, dup)).toBe(201);
    expect(await bad(app, dup)).toBe(409);
    // content-type enforced
    expect((await app.request("/api/v1/tool-connections", { method: "POST", headers: { ...(await hdr(A)), "content-type": "text/plain" }, body: "x" })).status).toBe(415);
  });

  test("roles: only owner/admin; unauthenticated 401", async () => {
    const A = await seedTenantWithUser(owner, "tc-role");
    const created = (await (await mkConn(app, A)).json()) as { id: string };
    for (const role of ["agent", "viewer"] as const) {
      const h = await hdr(A, role);
      expect((await call(app, "GET", "/tool-connections", h)).status).toBe(403);
      expect((await call(app, "POST", "/tool-connections", h, { name: "x", baseUrl: "https://a.test" })).status).toBe(403);
      expect((await call(app, "PATCH", `/tool-connections/${created.id}`, h, { name: "y" })).status).toBe(403);
      expect((await call(app, "DELETE", `/tool-connections/${created.id}`, h)).status).toBe(403);
      expect((await call(app, "POST", `/tool-connections/${created.id}/test`, h, {})).status).toBe(403);
      expect((await call(app, "POST", "/tools/test", h, { manifest: {} })).status).toBe(403);
    }
    expect((await call(app, "GET", "/tool-connections", await hdr(A, "admin"))).status).toBe(200);
    expect((await call(app, "GET", "/tool-connections", { "content-type": "application/json" })).status).toBe(401);
    expect((await call(app, "POST", "/tools/test", { "content-type": "application/json" }, {})).status).toBe(401);
  });

  test("503 when ENCRYPTION_KEY is missing and a secret is involved", async () => {
    const A = await seedTenantWithUser(owner, "tc-nokey");
    expect((await mkConn(appNoKey, A)).status).toBe(503);
    expect((await mkConn(appNoKey, A, { authType: "none", secret: undefined })).status).toBe(201);
    const withSecret = (await (await mkConn(app, A)).json()) as { id: string };
    expect((await call(appNoKey, "POST", `/tool-connections/${withSecret.id}/test`, await hdr(A), {})).status).toBe(503);
    expect((await call(appNoKey, "POST", "/tools/test", await hdr(A), { manifest: manifestOf(withSecret.id) })).status).toBe(503);
  });

  function manifestOf(connectionId: string, over: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
    return {
      version: 2, name: "lookup_order", description: "Look up an order",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: { type: "object" },
      connectionId, request: { method: "GET", path: "/orders/{{id}}", fields: [{ name: "id", in: "path" }], ...request }, ...over,
    };
  }

  test("POST /tool-connections/:id/test: real call with credentials, redacted result", async () => {
    const A = await seedTenantWithUser(owner, "tc-test");
    const c = (await (await mkConn(app, A, { testPath: "/health" })).json()) as { id: string };
    const res = await call(app, "POST", `/tool-connections/${c.id}/test`, await hdr(A), {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, any>;
    expect(out).toMatchObject({ ok: true, status: 200, contentType: expect.stringContaining("json"), error: null });
    expect(out.excerpt).toContain("ok");
    expect(out.request.headers.authorization).toBe("Bearer ***");
    expect(JSON.stringify(out)).not.toContain("tok_PLAINTEXT_123");
    expect(seen[seen.length - 1]!.headers.authorization).toBe("Bearer tok_PLAINTEXT_123");
    const bad = (await (await call(app, "POST", `/tool-connections/${c.id}/test`, await hdr(A), { path: "/boom" })).json()) as Record<string, any>;
    expect(bad).toMatchObject({ ok: false, status: 500, error: { code: "http_error" } });
  });

  test("POST /tools/test: status, latency, redacted request, excerpt, mapping and field tree; secrets never returned or audited", async () => {
    const A = await seedTenantWithUser(owner, "tc-tool");
    const c = (await (await mkConn(app, A, { authType: "hmac", secret: "whsec_SIGNING_777" })).json()) as { id: string };
    const m = manifestOf(c.id, { responseMapping: { status: "status", skus: "lines[].sku", email: "customer.email" } });
    const res = await call(app, "POST", "/tools/test", await hdr(A), { manifest: m, sampleValues: { id: "A-1001" } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, any>;
    expect(out).toMatchObject({ ok: true, status: 200, attempts: 1, error: null, mapped: { status: "shipped", skus: ["A", "B"], email: "a@b.c" } });
    expect(typeof out.latencyMs).toBe("number");
    expect(out.request).toMatchObject({ method: "GET", url: "https://shop.test/orders/A-1001" });
    expect(out.request.headers["x-yulona-signature"]).toBe("v1=***");
    expect(out.response.status).toBe(200);
    expect(out.response.excerpt).toContain("shipped");
    expect(out.fieldTree.rootType).toBe("object");
    const lines = out.fieldTree.fields.find((f: any) => f.name === "lines");
    expect(lines).toMatchObject({ type: "array", itemType: "object" });
    expect(lines.children.map((x: any) => x.path)).toEqual(["lines[].sku", "lines[].qty"]);
    expect(JSON.stringify(out)).not.toContain("whsec_SIGNING_777");
    const sent = seen[seen.length - 1]!;
    expect(sent.headers["x-yulona-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);

    // backend errors and bad sample values are reported, not thrown
    const boom = (await (await call(app, "POST", "/tools/test", await hdr(A), { manifest: manifestOf(c.id, {}, { path: "/boom", fields: [{ name: "id", in: "query" }] }), sampleValues: { id: "1" } })).json()) as Record<string, any>;
    expect(boom).toMatchObject({ ok: false, status: 500, error: { code: "http_error", status: 500 }, fieldTree: null });
    const inv = (await (await call(app, "POST", "/tools/test", await hdr(A), { manifest: m, sampleValues: { wrong: 1 } })).json()) as Record<string, any>;
    expect(inv).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    // manifest validation => 400 with a path
    const v = await call(app, "POST", "/tools/test", await hdr(A), { manifest: manifestOf(c.id, {}, { path: "/x/{{nope}}" }) });
    expect(v.status).toBe(400);
    expect(JSON.stringify(await v.json())).toContain("manifest.request.path");
    expect((await call(app, "POST", "/tools/test", await hdr(A), { manifest: { version: 1, name: "old_one", description: "d", authType: "none", inputSchema: {}, outputSchema: {} } })).status).toBe(400);
    expect((await call(app, "POST", "/tools/test", await hdr(A), { manifest: m, extra: 1 })).status).toBe(400);

    const audits = await owner<{ action: string; metadata: unknown }[]>`SELECT action, metadata FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action = 'tool.test'`;
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits)).not.toContain("whsec_SIGNING_777");
  });

  test("SSRF at call time: a connection whose host resolves to a private address is blocked", async () => {
    const A = await seedTenantWithUser(owner, "tc-ssrf");
    const c = (await (await mkConn(app, A)).json()) as { id: string };
    // same app, but DNS now points at a private range
    const s = await setupTestDb();
    const cfg = testConfig({ DEPLOYMENT_MODE: "selfhosted", ENCRYPTION_KEY: KEY }, (x) => { x.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; });
    const hostile = createApp({ cfg, db: s.app, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent" }), tools: { resolver: async () => ["10.0.0.7"] } });
    const out = (await (await call(hostile, "POST", "/tools/test", await hdr(A), { manifest: manifestOf(c.id), sampleValues: { id: "1" } })).json()) as Record<string, any>;
    expect(out).toMatchObject({ ok: false, error: { code: "ssrf_blocked" } });
    const t = (await (await call(hostile, "POST", `/tool-connections/${c.id}/test`, await hdr(A), {})).json()) as Record<string, any>;
    expect(t).toMatchObject({ ok: false, error: { code: "ssrf_blocked" } });
    await s.app.end({ timeout: 2 });
    await s.owner.end({ timeout: 2 });
  });

  test("a connection that tools still use cannot be deleted", async () => {
    const A = await seedTenantWithUser(owner, "tc-inuse");
    const c = (await (await mkConn(app, A)).json()) as { id: string };
    const ag = await call(app, "POST", "/agents", await hdr(A), { name: "Shop bot", config: { enabledTools: ["lookup_order"], customTools: [manifestOf(c.id)] } });
    expect(ag.status).toBe(201); // bare v2 manifest passes agentConfigSchema
    const del = await call(app, "DELETE", `/tool-connections/${c.id}`, await hdr(A));
    expect(del.status).toBe(409);
    expect(JSON.stringify(await del.json())).toContain("Shop bot");
    // the agent API rejects an invalid v2 manifest with a path into customTools
    const badAg = await call(app, "POST", "/agents", await hdr(A), { name: "Bad", config: { customTools: [manifestOf(c.id, {}, { method: "POST", path: "/x", fields: [] }, )].map((x) => ({ ...x, retry: { attempts: 3 } })) } });
    expect(badAg.status).toBe(400);
  });

  test("cross-tenant: tenant B cannot see, change, delete, test, or use tenant A's connection", async () => {
    const A = await seedTenantWithUser(owner, "tc-xa");
    const B = await seedTenantWithUser(owner, "tc-xb");
    const c = (await (await mkConn(app, A, { name: "A-only" })).json()) as { id: string };
    const hb = await hdr(B);
    const before = await owner`SELECT md5(t::text) AS h FROM tool_connections t WHERE id = ${c.id}`;
    const reqs: [string, string, unknown?][] = [
      ["GET", `/tool-connections/${c.id}`],
      ["PATCH", `/tool-connections/${c.id}`, { name: "hacked" }],
      ["DELETE", `/tool-connections/${c.id}`],
      ["POST", `/tool-connections/${c.id}/test`, {}],
    ];
    for (const [m, p, b] of reqs) expect((await call(app, m, p, hb, b)).status).toBe(404);
    const list = (await (await call(app, "GET", "/tool-connections", hb)).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
    const sentBefore = seen.length;
    const t = await call(app, "POST", "/tools/test", hb, { manifest: manifestOf(c.id), sampleValues: { id: "1" } });
    expect(t.status).toBe(404);
    expect(seen.length).toBe(sentBefore); // nothing was sent with A's credential
    expect(await owner`SELECT md5(t::text) AS h FROM tool_connections t WHERE id = ${c.id}`).toEqual(before);
    // B cannot create a connection pointing at A's name collision-free and A is unaffected by B's same name
    expect((await mkConn(app, B, { name: "A-only" })).status).toBe(201);
  });

  test("rate limit: 20 tests per minute per tenant", async () => {
    const A = await seedTenantWithUser(owner, "tc-rl");
    const c = (await (await mkConn(app, A, { testPath: "/health" })).json()) as { id: string };
    const h = await hdr(A);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call(app, "POST", `/tool-connections/${c.id}/test`, h, {})).status;
    expect(last).toBe(429);
    expect((await call(app, "POST", "/tools/test", h, { manifest: manifestOf(c.id), sampleValues: { id: "1" } })).status).toBe(429);
  });
});
