import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "@yulona/db";
import { SKIP_MESSAGE, testUrls } from "@yulona/db/testing";
import { ingestSource } from "@yulona/ai-runtime";
import { createLogger } from "@yulona/shared";
import { DB_NAME, setupAiDb, seedAgent, type TestEnv } from "../../../packages/ai-runtime/test/helpers";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { PASSWORD, json, testConfig, uniqueEmail } from "./helpers";

const enabled = !!testUrls();
if (!enabled) console.warn(SKIP_MESSAGE);
const d = enabled ? describe : describe.skip;

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let limiter: MemoryRateLimiter;
const A = { token: "", tenantId: "", agentId: "" };
const B = { token: "", tenantId: "", agentId: "" };

async function signup(): Promise<{ token: string; tenantId: string }> {
  const res = await app.request("/api/v1/auth/register", json({ email: uniqueEmail(), password: PASSWORD, name: "Owner", workspaceName: "W" }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string; tenant: { id: string } };
  return { token: body.accessToken, tenantId: body.tenant.id };
}
const call = (who: { token: string }, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${who.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const upload = (who: { token: string }, name: string, bytes: Uint8Array | string, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("file", new File([bytes as BlobPart], name));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return app.request("/api/v1/knowledge/sources/file", { method: "POST", headers: { authorization: `Bearer ${who.token}` }, body: f });
};

beforeAll(async () => {
  if (!enabled) return;
  env = (await setupAiDb())!;
  limiter = new MemoryRateLimiter();
  const urls = testUrls()!;
  const u = new URL(urls.owner);
  u.pathname = `/${DB_NAME}`;
  u.username = "yulona_app";
  u.password = "yulona_app";
  const db = createDb(u.toString(), { max: 5 });
  app = createApp({ cfg: testConfig({ DATABASE_URL: u.toString() }), db, limiter, log: createLogger({ level: "silent" }) });
  Object.assign(A, await signup());
  Object.assign(B, await signup());
  A.agentId = await seedAgent(env.owner, A.tenantId);
  B.agentId = await seedAgent(env.owner, B.tenantId);
});
afterAll(async () => {
  if (enabled) {
    limiter.close();
    await env.close();
  }
});

d("knowledge API", () => {
  let textId = "";
  test("auth required", async () => {
    expect((await app.request("/api/v1/knowledge/sources")).status).toBe(401);
    expect((await app.request("/api/v1/knowledge/sandbox", { method: "POST" })).status).toBe(401);
  });

  test("create text source: strict body, queued job, audit log", async () => {
    expect((await call(A, "POST", "/knowledge/sources/text", { name: "n", text: "t", tenantId: B.tenantId })).status).toBe(400);
    expect((await call(A, "POST", "/knowledge/sources/text", { name: "n", text: "t", agentId: B.agentId })).status).toBe(400); // other tenant's agent
    const res = await call(A, "POST", "/knowledge/sources/text", { name: "Hours", text: "Our store opening hours are nine to five Monday through Friday. We close on weekends.", agentId: A.agentId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("pending");
    textId = body.id;
    const jobs = await env.owner`SELECT payload FROM jobs WHERE tenant_id = ${A.tenantId} AND name = 'knowledge.ingest'`;
    expect(jobs.some((j) => (j.payload as { sourceId: string }).sourceId === textId)).toBe(true);
    const aud = await env.owner`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action = 'knowledge.source.create'`;
    expect(aud[0]!.n).toBeGreaterThan(0);
  });

  test("ingest -> ready; chunks listable; sandbox returns retrieved chunks + scores", async () => {
    expect(await ingestSource({ db: createDbFor() }, { tenantId: A.tenantId, sourceId: textId })).toBe("ready");
    const s = (await (await call(A, "GET", `/knowledge/sources/${textId}`)).json()) as { status: string; chunkCount: number };
    expect(s).toMatchObject({ status: "ready", chunkCount: 1 });
    const ch = (await (await call(A, "GET", `/knowledge/sources/${textId}/chunks`)).json()) as { items: unknown[] };
    expect(ch.items).toHaveLength(1);
    // the source is a skill: folder-like id + automatic description, editable by the operator
    expect(s).toMatchObject({ skill: "hours" });
    expect(typeof (s as unknown as { description: string }).description).toBe("string");
    const patched = await call(A, "PATCH", `/knowledge/sources/${textId}`, { description: "Opening times and holiday closures" });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ skill: "hours", description: "Opening times and holiday closures" });
    expect((await call(A, "PATCH", `/knowledge/sources/${textId}`, {})).status).toBe(400);
    expect((await call(A, "PATCH", `/knowledge/sources/${textId}`, { skill: "x" })).status).toBe(400);
    expect((await call(B, "PATCH", `/knowledge/sources/${textId}`, { name: "hijack" })).status).toBe(404);
    const res = await call(A, "POST", "/knowledge/sandbox", { agentId: A.agentId, message: "opening hours" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { retrieved: { score: number; sourceName: string }[]; stageAfter: string; answer: string };
    expect(out.retrieved[0]!.sourceName.startsWith("Hours")).toBe(true);
    expect(out.stageAfter).toBe("engaged");
    expect((await call(A, "POST", "/knowledge/sandbox", { agentId: A.agentId, message: "x", tenantId: "y" })).status).toBe(400);
  });

  test("file upload: magic bytes, unknown fields, valid txt", async () => {
    expect((await upload(A, "evil.txt", new Uint8Array([0x4d, 0x5a, 0x90, 0, 3]))).status).toBe(400);
    expect((await upload(A, "fake.pdf", "just text")).status).toBe(400);
    expect((await upload(A, "x.exe", "hello")).status).toBe(400);
    expect((await upload(A, "ok.txt", "hello world", { tenantId: B.tenantId })).status).toBe(400);
    const ok = await upload(A, "ok.txt", "Shipping takes five days.");
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { type: string }).type).toBe("file");
  });

  test("url source rejects private/metadata hosts", async () => {
    for (const url of ["http://169.254.169.254/", "http://localhost:3000/", "file:///etc/passwd", "http://10.0.0.1/"]) {
      expect((await call(A, "POST", "/knowledge/sources/url", { url })).status).toBe(400);
    }
  });

  test("url source crawl settings: defaults, explicit values, limits and the stored config", async () => {
    const url = "http://93.184.216.34/";
    const dflt = await call(A, "POST", "/knowledge/sources/url", { url });
    expect(dflt.status).toBe(201);
    expect(await dflt.json()).toMatchObject({ type: "url", maxPages: 25, maxDepth: 3, followLinks: true, includeSubdomains: false, crawlProgress: null });
    const one = await call(A, "POST", "/knowledge/sources/url", { url, maxPages: 1 });
    expect(await one.json()).toMatchObject({ maxPages: 1, followLinks: false, maxDepth: 3 });
    const custom = await call(A, "POST", "/knowledge/sources/url", { url, maxPages: 50, maxDepth: 5, followLinks: true, includeSubdomains: true });
    const c = (await custom.json()) as { id: string; maxPages: number };
    expect(c).toMatchObject({ maxPages: 50, maxDepth: 5, followLinks: true, includeSubdomains: true });
    const [row] = await env.owner<{ crawlConfig: Record<string, unknown> }[]>`SELECT crawl_config FROM knowledge_sources WHERE id = ${c.id}`;
    expect(row!.crawlConfig).toEqual({ maxPages: 50, maxDepth: 5, followLinks: true, includeSubdomains: true });
    const off = await call(A, "POST", "/knowledge/sources/url", { url, maxPages: 10, followLinks: false });
    expect(await off.json()).toMatchObject({ maxPages: 10, followLinks: false });
    for (const bad of [{ maxPages: 51 }, { maxPages: 0 }, { maxDepth: 6 }, { maxDepth: 0 }, { followLinks: "yes" }, { includeSubdomains: 1 }, { depth: 3 }])
      expect((await call(A, "POST", "/knowledge/sources/url", { url, ...bad })).status).toBe(400);
  });

  test("names and descriptions are stored as one clean line", async () => {
    const r = await call(A, "POST", "/knowledge/sources/text", { name: "  Opening \n  hours ", text: "We open at nine.", description: "Hours\n\n  of   business" });
    expect(await r.json()).toMatchObject({ name: "Opening hours", description: "Hours of business" });
  });

  test("cross-tenant: tenant B cannot see, read, re-ingest, delete or use tenant A's data", async () => {
    expect(((await (await call(B, "GET", "/knowledge/sources")).json()) as { items: unknown[] }).items).toHaveLength(0);
    expect((await call(B, "GET", `/knowledge/sources/${textId}`)).status).toBe(404);
    expect((await call(B, "GET", `/knowledge/sources/${textId}/chunks`)).status).toBe(404);
    expect((await call(B, "POST", `/knowledge/sources/${textId}/reingest`)).status).toBe(404);
    expect((await call(B, "DELETE", `/knowledge/sources/${textId}`)).status).toBe(404);
    expect((await call(B, "GET", "/knowledge/sources/not-a-uuid")).status).toBe(404);
    expect((await call(B, "POST", "/knowledge/sandbox", { agentId: A.agentId, message: "opening hours" })).status).toBe(404);
    // B's own sandbox finds nothing of A's knowledge
    const own = (await (await call(B, "POST", "/knowledge/sandbox", { agentId: B.agentId, message: "opening hours" })).json()) as { retrieved: unknown[]; guardTriggered: boolean };
    expect(own.retrieved).toHaveLength(0);
    expect(own.guardTriggered).toBe(true);
  });

  test("reingest then delete cascades chunks", async () => {
    expect((await call(A, "POST", `/knowledge/sources/${textId}/reingest`)).status).toBe(202);
    expect((await call(A, "POST", `/knowledge/sources/${textId}/reingest`)).status).toBe(409);
    expect((await call(A, "DELETE", `/knowledge/sources/${textId}`)).status).toBe(200);
    expect((await call(A, "GET", `/knowledge/sources/${textId}`)).status).toBe(404);
    expect((await env.owner`SELECT count(*)::int AS n FROM knowledge_chunks WHERE source_id = ${textId}`)[0]!.n).toBe(0);
  });
});

let dbCache: ReturnType<typeof createDb> | undefined;
function createDbFor() {
  const u = new URL(testUrls()!.owner);
  u.pathname = `/${DB_NAME}`;
  u.username = "yulona_app";
  u.password = "yulona_app";
  return (dbCache ??= createDb(u.toString(), { max: 3 }));
}
