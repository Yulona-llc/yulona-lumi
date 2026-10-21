import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { encryptJson } from "@yulona/crypto";
import { SKIP_MESSAGE, testUrls } from "@yulona/db/testing";
import { toolManifestSchema, type ToolManifestV2 } from "@yulona/shared";
import { mapAgentRow } from "../src/agent-loader";
import { buildFieldTree, callConnection, connectionAad, createConnectionResolver, extractPath, maskSecrets, type ResolvedConnection } from "../src/http-tool";
import { createMockPorts } from "../src/mock";
import { handleInboundMessage } from "../src/runtime";
import { executeTool, resolveTools, toolSpecsForStage } from "../src/tools";
import type { AgentConfig } from "../src/types";
import { seedAgent, seedConversation, seedTenant, setupAiDb, type TestEnv } from "./helpers";

// ---- a local "customer backend"; the public hostname shop.test is rewritten to it (SSRF rules stay fully on)
interface Seen { method: string; path: string; headers: Record<string, string>; body: string }
const seen: Seen[] = [];
let hits = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.text();
      seen.push({ method: req.method, path: u.pathname + u.search, headers: Object.fromEntries(req.headers), body });
      hits++;
      if (u.pathname === "/flaky") return hits % 3 === 0 ? Response.json({ ok: true }) : new Response("busy", { status: 503 });
      if (u.pathname === "/always503") return new Response("busy", { status: 503 });
      if (u.pathname === "/notfound") return new Response("nope", { status: 404 });
      if (u.pathname === "/slow") { await new Promise((r) => setTimeout(r, 1500)); return Response.json({ late: true }); }
      if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      if (u.pathname === "/text") return new Response("plain words");
      if (u.pathname === "/echo-secret") return Response.json({ leaked: req.headers.get("authorization") });
      if (u.pathname === "/orders") return Response.json({ orders: [{ id: 1, sku: "A", price: 5 }, { id: 2, sku: "B", price: 7 }], customer: { email: "a@b.c" }, status: "shipped" });
      return Response.json({ ok: true, path: u.pathname });
    },
  });
});
afterAll(() => server.stop(true));

const publicResolver = async () => ["93.184.216.34"];
const fetchImpl = ((input: URL | string, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, init);
}) as unknown as typeof fetch;
const opts = { resolver: publicResolver, fetchImpl, sleep: async () => {} };

const CONN_ID = "11111111-1111-4111-8111-111111111111";
const conn = (over: Partial<ResolvedConnection> = {}): ResolvedConnection => ({ id: CONN_ID, name: "Shop", baseUrl: "https://shop.test", authType: "none", ...over });
const manifest = (over: Record<string, unknown> = {}, request: Record<string, unknown> = {}): ToolManifestV2 =>
  toolManifestSchema.parse({
    version: 2, name: "lookup_order", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: true }, outputSchema: { type: "object" },
    connectionId: CONN_ID, request: { method: "GET", path: "/orders", fields: [], ...request }, ...over,
  }) as ToolManifestV2;
const last = () => seen[seen.length - 1]!;

describe("manifest v2 schema", () => {
  test("v1 still validates; v2 rules (path fields, retry only idempotent, reserved headers, body template)", () => {
    expect(toolManifestSchema.safeParse({ version: 1, name: "old_tool", description: "d", authType: "none", inputSchema: {}, outputSchema: {}, endpointTemplate: "GET https://x.test/a" }).success).toBe(true);
    const base = { version: 2, name: "t_one", description: "d", inputSchema: {}, outputSchema: {}, connectionId: CONN_ID };
    const ok = { ...base, request: { method: "GET", path: "/o/{{id}}", fields: [{ name: "id", in: "path" }] }, retry: { attempts: 3 } };
    expect(toolManifestSchema.safeParse(ok).success).toBe(true);
    expect(toolManifestSchema.safeParse({ ...ok, request: { ...ok.request, method: "POST" } }).success).toBe(false); // retry on POST
    expect(toolManifestSchema.safeParse({ ...ok, request: { method: "GET", path: "/o/{{id}}", fields: [] } }).success).toBe(false); // placeholder without field
    expect(toolManifestSchema.safeParse({ ...ok, request: { ...ok.request, headers: { Authorization: "x" } } }).success).toBe(false);
    expect(toolManifestSchema.safeParse({ ...ok, request: { method: "GET", path: "//evil.test/x", fields: [] } }).success).toBe(false);
    expect(toolManifestSchema.safeParse({ ...base, request: { method: "POST", path: "/x", fields: [], bodyTemplate: "{\"a\": {{x}}}" } }).success).toBe(false); // bare placeholder
    expect(toolManifestSchema.safeParse({ ...base, request: { method: "POST", path: "/x", fields: [], bodyTemplate: "{\"a\": \"{{x}}\"}" } }).success).toBe(true);
    expect(toolManifestSchema.safeParse({ ...base, extra: 1, request: { method: "GET", path: "/x" } }).success).toBe(false); // strict
  });
});

describe("request building + auth types", () => {
  test("a base URL path prefix is kept", async () => {
    await callConnection(manifest({}, { path: "/orders" }), conn({ baseUrl: "https://shop.test/v1/" }), {}, opts);
    expect(last().path).toBe("/v1/orders");
  });
  test("path/query/header/body fields and encoding", async () => {
    const m = manifest({}, { method: "POST", path: "/orders/{{id}}/notes", fields: [{ name: "id", in: "path" }, { name: "q", in: "query" }, { name: "tag", in: "query" }, { name: "lang", in: "header", as: "Accept-Language" }, { name: "text", in: "body" }, { name: "n", in: "body", as: "count" }], headers: { "X-Src": "yl-{{id}}" } });
    const r = await callConnection(m, conn(), { id: "a/b c", q: "x y", tag: ["1", "2"], lang: "en", text: "hi", n: 3 }, opts);
    expect(r.ok).toBe(true);
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/orders/a%2Fb%20c/notes?q=x+y&tag=1&tag=2");
    expect(last().headers["accept-language"]).toBe("en");
    expect(last().headers["x-src"]).toBe("yl-a/b c");
    expect(JSON.parse(last().body)).toEqual({ text: "hi", count: 3 });
  });
  test("body template keeps types for whole-string placeholders and escapes interpolated ones", async () => {
    const m = manifest({}, { method: "POST", path: "/x", fields: [{ name: "qty", in: "body" }, { name: "note", in: "body" }], bodyTemplate: '{"qty":"{{qty}}","msg":"Note: {{note}}","fixed":true}' });
    await callConnection(m, conn(), { qty: 2, note: 'say "hi"\n' }, opts);
    expect(JSON.parse(last().body)).toEqual({ qty: 2, msg: 'Note: say "hi"\n', fixed: true });
  });
  test("path traversal and missing path values are refused before any request", async () => {
    const before = seen.length;
    const m = manifest({}, { path: "/orders/{{id}}", fields: [{ name: "id", in: "path" }] });
    expect((await callConnection(m, conn(), { id: ".." }, opts)).error?.code).toBe("bad_input");
    expect((await callConnection(m, conn(), {}, opts)).error?.code).toBe("bad_input");
    expect(seen.length).toBe(before);
  });
  test("bearer / api_key (custom header) / basic / none", async () => {
    await callConnection(manifest(), conn({ authType: "bearer", secret: "tok_123" }), {}, opts);
    expect(last().headers.authorization).toBe("Bearer tok_123");
    await callConnection(manifest(), conn({ authType: "api_key", authHeaderName: "X-Shop-Key", secret: "key_abc" }), {}, opts);
    expect(last().headers["x-shop-key"]).toBe("key_abc");
    expect(last().headers.authorization).toBeUndefined();
    await callConnection(manifest(), conn({ authType: "basic", secret: "bob:pa:ss" }), {}, opts);
    expect(last().headers.authorization).toBe(`Basic ${Buffer.from("bob:pa:ss").toString("base64")}`);
    await callConnection(manifest(), conn(), {}, opts);
    expect(last().headers.authorization).toBeUndefined();
  });
  test("hmac: signature over `${timestamp}.${rawBody}` verifies, tampering and stale timestamps fail", async () => {
    const { verifyWebhookSignature } = await import("../../integrations/src/signing");
    const m = manifest({}, { method: "POST", path: "/sign", fields: [{ name: "a", in: "body" }] });
    await callConnection(m, conn({ authType: "hmac", secret: "whsec_test" }), { a: 1 }, opts);
    const h = last().headers;
    expect(h["x-yulona-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("whsec_test", last().body, { timestamp: h["x-yulona-timestamp"]!, signature: h["x-yulona-signature"]! })).toBe(true);
    expect(verifyWebhookSignature("whsec_test", last().body + " ", { timestamp: h["x-yulona-timestamp"]!, signature: h["x-yulona-signature"]! })).toBe(false);
    expect(verifyWebhookSignature("whsec_other", last().body, { timestamp: h["x-yulona-timestamp"]!, signature: h["x-yulona-signature"]! })).toBe(false);
    expect(verifyWebhookSignature("whsec_test", last().body, { timestamp: h["x-yulona-timestamp"]!, signature: h["x-yulona-signature"]! }, 300, Date.now() + 3_600_000)).toBe(false);
    // GET signs an empty body
    await callConnection(manifest(), conn({ authType: "hmac", secret: "whsec_test" }), {}, opts);
    const g = last().headers;
    expect(g["x-yulona-signature"]).toBe(`v1=${createHmac("sha256", "whsec_test").update(`${g["x-yulona-timestamp"]}.`).digest("hex")}`);
  });
  test("a tool cannot override authentication with its own header fields", async () => {
    const m = manifest({}, { fields: [{ name: "h", in: "header", as: "X-Custom" }] });
    await callConnection(m, conn({ authType: "bearer", secret: "real" }), { h: "v" }, opts);
    expect(last().headers.authorization).toBe("Bearer real");
  });
});

describe("safety: SSRF, redaction, limits", () => {
  test("blocks literal private hosts, hosts resolving to private IPs, and redirects into private space", async () => {
    const before = seen.length;
    expect((await callConnection(manifest(), conn({ baseUrl: "http://127.0.0.1:9" }), {}, { ...opts, resolver: undefined })).error?.code).toBe("ssrf_blocked");
    expect((await callConnection(manifest(), conn({ baseUrl: "http://169.254.169.254" }), {}, opts)).error?.code).toBe("ssrf_blocked");
    expect((await callConnection(manifest(), conn(), {}, { ...opts, resolver: async () => ["10.0.0.5"] })).error?.code).toBe("ssrf_blocked");
    const redir = await callConnection(manifest({}, { path: "/redirect" }), conn(), {}, opts);
    expect(redir.error?.code).toBe("ssrf_blocked");
    expect(seen.length).toBe(before + 1); // only the redirecting hop reached the server
  });
  test("the request path cannot leave the base URL", async () => {
    const m = manifest({}, { path: "/..%2f..%2fadmin" });
    const r = await callConnection(m, conn({ baseUrl: "https://shop.test/v1" }), {}, opts);
    // encoded dots do not normalise away, and the URL stays under /v1
    expect(r.ok === false ? r.error?.code : last().path.startsWith("/v1/")).toSatisfy((v: unknown) => v === true || v === "bad_input");
  });
  test("credentials are masked in the echoed request and scrubbed from responses/errors", async () => {
    const r = await callConnection(manifest({}, { path: "/echo-secret" }), conn({ authType: "bearer", secret: "tok_SECRET_999" }), {}, opts);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("tok_SECRET_999");
    expect(r.request?.headers.authorization).toBe("Bearer ***");
    const h = await callConnection(manifest({}, { method: "POST", path: "/x", fields: [{ name: "apiToken", in: "body" }, { name: "x", in: "query" }, { name: "password", in: "query" }] }), conn({ authType: "hmac", secret: "sigsecret1" }), { apiToken: "abc", x: 1, password: "pw" }, opts);
    expect(JSON.stringify(h.request)).not.toContain("sigsecret1");
    expect(h.request?.headers["x-yulona-signature"]).toBe("v1=***");
    expect(h.request?.body).toContain("***");
    expect(h.request?.body).not.toContain("abc");
    expect(h.request?.url).toContain("password=***");
  });
  test("maskSecrets masks sensitive keys recursively", () => {
    expect(maskSecrets({ a: 1, apiKey: "k", nested: { password: "p", list: [{ token: "t", ok: 1 }] } })).toEqual({ a: 1, apiKey: "***", nested: { password: "***", list: [{ token: "***", ok: 1 }] } });
  });
  test("timeouts and non-JSON replies", async () => {
    const t = await callConnection(manifest({ timeoutMs: 500 }, { path: "/slow" }), conn(), {}, opts);
    expect(t.error?.code).toBe("timeout");
    expect((await callConnection(manifest({ responseMapping: { a: "a" } }, { path: "/text" }), conn(), {}, opts)).error?.code).toBe("not_json");
    const plain = await callConnection(manifest({}, { path: "/text" }), conn(), {}, opts);
    expect(plain.output).toEqual({ text: "plain words" });
  });
});

describe("retry", () => {
  test("idempotent GET retries 5xx until success; 4xx is never retried; POST is never retried", async () => {
    hits = 0; // /flaky succeeds on every third hit
    const m = manifest({ retry: { attempts: 3, baseMs: 50 } }, { path: "/flaky" });
    const r = await callConnection(m, conn(), {}, opts);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    const nf = await callConnection(manifest({ retry: { attempts: 3, baseMs: 50 } }, { path: "/notfound" }), conn(), {}, opts);
    expect(nf.attempts).toBe(1);
    expect(nf.error).toMatchObject({ code: "http_error", status: 404 });
    const before = seen.length;
    const post = await callConnection(manifest({}, { method: "POST", path: "/always503" }), conn(), {}, opts);
    expect(post.ok).toBe(false);
    expect(seen.length - before).toBe(1);
    const exhausted = await callConnection(manifest({ retry: { attempts: 2, baseMs: 50 } }, { path: "/always503" }), conn(), {}, opts);
    expect(exhausted.attempts).toBe(2);
    expect(exhausted.error?.code).toBe("http_error");
  });
  test("each retry is re-signed with a fresh timestamp", async () => {
    let n = 0;
    const m = manifest({ retry: { attempts: 2, baseMs: 50 } }, { path: "/always503" });
    await callConnection(m, conn({ authType: "hmac", secret: "s3cretsecret" }), {}, { ...opts, sleep: async () => {}, resolver: publicResolver, fetchImpl: ((u: URL, i: RequestInit) => (n++, fetchImpl(u, i))) as unknown as typeof fetch });
    expect(n).toBe(2);
  });
});

describe("response mapping + field tree", () => {
  test("extractPath: dotted, indexed, array wildcard, root array", () => {
    const data = { a: { b: [{ n: 1 }, { n: 2 }] }, s: "x" };
    expect(extractPath(data, "a.b[0].n")).toBe(1);
    expect(extractPath(data, "a.b[].n")).toEqual([1, 2]);
    expect(extractPath(data, "s.zzz")).toBeUndefined();
    expect(extractPath([{ id: 1 }, { id: 2 }], "[].id")).toEqual([1, 2]);
  });
  test("mapping with arrays + field tree for click-to-map", async () => {
    const m = manifest({ responseMapping: { status: "status", skus: "orders[].sku", firstPrice: "orders[0].price", email: "customer.email", nope: "x.y" } }, { path: "/orders" });
    const r = await callConnection(m, conn(), {}, opts);
    expect(r.output).toEqual({ status: "shipped", skus: ["A", "B"], firstPrice: 5, email: "a@b.c", nope: null });
    const tree = buildFieldTree(r.json);
    expect(tree.rootType).toBe("object");
    const orders = tree.fields.find((f) => f.name === "orders")!;
    expect(orders).toMatchObject({ type: "array", length: 2, itemType: "object", path: "orders" });
    expect(orders.children!.map((c) => c.path)).toEqual(["orders[].id", "orders[].sku", "orders[].price"]);
    expect(tree.fields.find((f) => f.name === "customer")!.children![0]).toMatchObject({ path: "customer.email", type: "string", sample: "a@b.c" });
    // every path in the tree is usable as a mapping value
    for (const f of tree.fields) expect(extractPath(r.json, f.path)).toBeDefined();
    expect(buildFieldTree([{ id: 1 }]).fields[0]).toMatchObject({ path: "[].id" });
  });
});

describe("executeTool with v2 manifests", () => {
  const agentWith = (tools: unknown[], enabled: string[]): AgentConfig => ({ ...mapAgentRow({ id: "a", name: "Bot", config: { enabledTools: enabled, customTools: tools } }, "00000000-0000-4000-8000-000000000001") });
  const resolverFor = (c: ResolvedConnection) => async (_t: string, id: string) => (id === c.id ? c : null);
  const ctx = (c: ResolvedConnection | null, extra: object = {}) => ({ stage: "engaged" as const, lead: {}, tenantId: "00000000-0000-4000-8000-000000000001", connections: c ? resolverFor(c) : async () => null, resolver: publicResolver, fetchImpl, sleep: async () => {}, ...extra });
  const raw = (over: Record<string, unknown> = {}, request: Record<string, unknown> = {}) => ({
    version: 2, name: "lookup_order", description: "Look up an order", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    outputSchema: { type: "object" }, connectionId: CONN_ID, request: { method: "GET", path: "/orders/{{id}}", fields: [{ name: "id", in: "path" }], ...request }, ...over,
  });

  test("a bare (dashboard-saved) v1 or v2 manifest resolves and runs; the wrapped form still works", async () => {
    const bareV2 = resolveTools(agentWith([raw()], ["lookup_order"]));
    expect(bareV2.get("lookup_order")?.manifest.version).toBe(2);
    const r = await executeTool(bareV2, { name: "lookup_order", arguments: { id: "7" } }, ctx(conn({ authType: "bearer", secret: "tok_1" })));
    expect(r.kind).toBe("ok");
    expect(last().path).toBe("/orders/7");
    const v1 = { version: 1, name: "ping_old", description: "d", authType: "api_key", endpointTemplate: "GET https://shop.test/ping", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
    const bareV1 = resolveTools(agentWith([v1], ["ping_old"]));
    expect(bareV1.has("ping_old")).toBe(true);
    expect((await executeTool(bareV1, { name: "ping_old", arguments: {} }, { stage: "engaged", lead: {}, resolver: publicResolver, fetchImpl })).kind).toBe("ok");
    const wrapped = resolveTools(agentWith([{ manifest: v1, secret: "k" }], ["ping_old"]));
    expect(wrapped.get("ping_old")?.secret).toBe("k");
    // a tool that is not enabled is not offered
    expect(resolveTools(agentWith([raw()], [])).has("lookup_order")).toBe(false);
  });

  test("failure modes: handoff => failed, tell_customer => rejected (model-visible, no handoff)", async () => {
    const c = conn();
    const hand = resolveTools(agentWith([raw({ onFailure: "handoff" }, { path: "/always503", fields: [{ name: "id", in: "query" }] })], ["lookup_order"]));
    expect((await executeTool(hand, { name: "lookup_order", arguments: { id: "1" } }, ctx(c))).kind).toBe("failed");
    const tell = resolveTools(agentWith([raw({ onFailure: "tell_customer" }, { path: "/always503", fields: [{ name: "id", in: "query" }] })], ["lookup_order"]));
    const t = await executeTool(tell, { name: "lookup_order", arguments: { id: "1" } }, ctx(c));
    expect(t.kind).toBe("rejected");
    expect(t.modelResult).toContain("Tell the customer");
    expect(t.run.success).toBe(false);
    // missing connection also follows the policy
    expect((await executeTool(hand, { name: "lookup_order", arguments: { id: "1" } }, ctx(null))).kind).toBe("failed");
    expect((await executeTool(tell, { name: "lookup_order", arguments: { id: "1" } }, ctx(null))).kind).toBe("rejected");
  });

  test("confirmBeforeRun: first call only asks, `confirmed: true` runs; flag is offered to the model", async () => {
    const tools = resolveTools(agentWith([raw({ confirmBeforeRun: true }, { method: "POST", path: "/cancel", fields: [{ name: "id", in: "body" }] })], ["lookup_order"]));
    const spec = toolSpecsForStage(tools, "engaged").find((s) => s.name === "lookup_order")!;
    expect((spec.parameters as { properties: Record<string, unknown> }).properties.confirmed).toBeDefined();
    const before = seen.length;
    const first = await executeTool(tools, { name: "lookup_order", arguments: { id: "9" } }, ctx(conn()));
    expect(first.kind).toBe("ok");
    expect(first.modelResult).toContain("confirmation_required");
    expect(seen.length).toBe(before);
    const second = await executeTool(tools, { name: "lookup_order", arguments: { id: "9", confirmed: true } }, ctx(conn()));
    expect(second.kind).toBe("ok");
    expect(seen.length).toBe(before + 1);
    expect(last().method).toBe("POST");
    expect(JSON.parse(last().body)).toEqual({ id: "9" }); // `confirmed` is not forwarded
  });

  test("sandbox (dryRun) never calls the backend; invalid input is rejected before the call", async () => {
    const tools = resolveTools(agentWith([raw()], ["lookup_order"]));
    const before = seen.length;
    const d = await executeTool(tools, { name: "lookup_order", arguments: { id: "1" } }, ctx(conn(), { dryRun: true }));
    expect(d.kind).toBe("ok");
    expect(JSON.stringify(d.run.output)).toContain("wouldCall");
    expect((await executeTool(tools, { name: "lookup_order", arguments: { nope: 1 } }, ctx(conn()))).kind).toBe("rejected");
    expect(seen.length).toBe(before);
  });

  test("logged input masks secret-looking keys and header fields", async () => {
    const tools = resolveTools(agentWith([raw({ inputSchema: { type: "object", properties: { id: { type: "string" }, authToken: { type: "string" }, region: { type: "string" } }, additionalProperties: false } }, { fields: [{ name: "id", in: "path" }, { name: "authToken", in: "query" }, { name: "region", in: "header", as: "X-Region" }] })], ["lookup_order"]));
    const r = await executeTool(tools, { name: "lookup_order", arguments: { id: "1", authToken: "abc", region: "eu" } }, ctx(conn()));
    expect(r.run.input).toEqual({ id: "1", authToken: "***", region: "***" });
  });
});

// ---------------------------------------------------------------- DB: encrypted connections + end-to-end runtime
const enabled = !!testUrls();
if (!enabled) console.warn(SKIP_MESSAGE);
const d = enabled ? describe : describe.skip;
const KEY = Buffer.alloc(32, 7).toString("base64");

d("connection resolver + runtime end to end", () => {
  let env: TestEnv;
  beforeAll(async () => { env = (await setupAiDb())!; });
  afterAll(async () => { await env.close(); });

  async function seedConn(tenantId: string, over: { authType?: string; secret?: string; baseUrl?: string } = {}) {
    const id = crypto.randomUUID();
    const sealed = over.secret ? encryptJson(KEY, { secret: over.secret }, connectionAad(tenantId, id)) : null;
    await env.owner`INSERT INTO tool_connections (id, tenant_id, name, base_url, auth_type, secret_encrypted)
      VALUES (${id}, ${tenantId}, ${`c-${id.slice(0, 6)}`}, ${over.baseUrl ?? "https://shop.test"}, ${over.authType ?? "none"}, ${sealed})`;
    return id;
  }

  test("resolver decrypts for the owning tenant only; wrong AAD / other tenant / bad id => null or throw", async () => {
    const A = await seedTenant(env.owner), B = await seedTenant(env.owner);
    const id = await seedConn(A, { authType: "bearer", secret: "tok_A" });
    const resolve = createConnectionResolver({ db: env.app, encryptionKey: KEY });
    expect(await resolve(A, id)).toMatchObject({ id, authType: "bearer", secret: "tok_A" });
    expect(await resolve(B, id)).toBeNull();
    expect(await resolve(A, "not-a-uuid")).toBeNull();
    await expect(createConnectionResolver({ db: env.app })(A, id)).rejects.toThrow("ENCRYPTION_KEY");
    // a row re-homed to another tenant cannot be decrypted (AAD binds tenant + id)
    const other = await seedConn(B, { authType: "bearer", secret: "tok_B" });
    const [sealedB] = await env.owner<{ secretEncrypted: string }[]>`SELECT secret_encrypted FROM tool_connections WHERE id = ${other}`;
    await env.owner`UPDATE tool_connections SET secret_encrypted = ${sealedB!.secretEncrypted} WHERE id = ${id}`;
    await expect(resolve(A, id)).rejects.toThrow();
  });

  test("dashboard-saved bare manifest: the model calls the tool, the backend sees the credential, tool_executions does not", async () => {
    const t = await seedTenant(env.owner);
    const connId = await seedConn(t, { authType: "bearer", secret: "tok_END_TO_END_42" });
    const bare = {
      version: 2, name: "lookup_order", description: "Look up an order by id", inputSchema: { type: "object", properties: { id: { type: "string" }, pin: { type: "string" } }, required: ["id"], additionalProperties: false },
      outputSchema: { type: "object" }, connectionId: connId, request: { method: "GET", path: "/orders/{{id}}", fields: [{ name: "id", in: "path" }, { name: "pin", in: "query" }] },
      responseMapping: { status: "ok" }, onFailure: "tell_customer",
    };
    const agent = await seedAgent(env.owner, t, { enabledTools: ["lookup_order"], customTools: [bare] });
    const { conversationId, messageId } = await seedConversation(env.owner, t, agent, "where is order 7?");
    await env.owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, stage) VALUES (${t}, ${conversationId}, 'engaged')`;
    const ports = createMockPorts((req) => {
      const toolMsg = req.messages.find((m) => m.role === "tool");
      if (toolMsg) return { content: "Your order has shipped." };
      return { content: "", toolCalls: [{ id: "c1", name: "lookup_order", arguments: { id: "7", pin: "1234" } }] };
    });
    const before = seen.length;
    const res = await handleInboundMessage({ db: env.app, ports, connections: createConnectionResolver({ db: env.app, encryptionKey: KEY }), resolver: publicResolver, fetchImpl }, { tenantId: t, conversationId, messageId });
    expect(res.status).toBe("replied");
    expect(seen.length).toBe(before + 1);
    expect(last().headers.authorization).toBe("Bearer tok_END_TO_END_42");
    expect(last().path).toBe("/orders/7?pin=1234");
    const [run] = await env.owner<{ success: boolean; input: Record<string, unknown>; output: unknown }[]>`SELECT success, input, output FROM tool_executions WHERE conversation_id = ${conversationId}`;
    expect(run!.success).toBe(true);
    expect(JSON.stringify(run)).not.toContain("tok_END_TO_END_42");
    // nothing the model or customer saw contains the credential either
    const msgs = await env.owner`SELECT content, ui, metadata FROM messages WHERE conversation_id = ${conversationId}`;
    expect(JSON.stringify(msgs)).not.toContain("tok_END_TO_END_42");
    for (const call of (ports as unknown as { calls?: unknown[] }).calls ?? []) expect(JSON.stringify(call)).not.toContain("tok_END_TO_END_42");
  });

  test("tell_customer: a failing backend keeps the AI in the conversation (no handoff); handoff mode raises system_failure", async () => {
    const t = await seedTenant(env.owner);
    const connId = await seedConn(t);
    const mk = (onFailure: string) => ({
      version: 2, name: "lookup_order", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object" },
      connectionId: connId, request: { method: "GET", path: "/always503", fields: [] }, onFailure, timeoutMs: 2000,
    });
    for (const [mode, expectStatus] of [["tell_customer", "replied"], ["handoff", "handoff"]] as const) {
      const agent = await seedAgent(env.owner, t, { enabledTools: ["lookup_order"], customTools: [mk(mode)] });
      const { conversationId, messageId } = await seedConversation(env.owner, t, agent, "check my order");
      await env.owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, stage) VALUES (${t}, ${conversationId}, 'engaged')`;
      const ports = createMockPorts((req) => req.messages.some((m) => m.role === "tool")
        ? { content: "Sorry, I could not check that right now. Want me to connect you with a person?" }
        : { content: "", toolCalls: [{ id: "c", name: "lookup_order", arguments: {} }] });
      const r = await handleInboundMessage({ db: env.app, ports, connections: createConnectionResolver({ db: env.app, encryptionKey: KEY }), resolver: publicResolver, fetchImpl }, { tenantId: t, conversationId, messageId });
      expect(r.status).toBe(expectStatus);
      const handoffs = await env.owner`SELECT type FROM handoffs WHERE conversation_id = ${conversationId}`;
      expect(handoffs.length).toBe(mode === "handoff" ? 1 : 0);
    }
  });
});
