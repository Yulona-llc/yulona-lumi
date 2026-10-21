import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockPorts, type LlmRequest, type LlmResult } from "@yulona/ai-runtime";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

type Script = (req: LlmRequest, call: number) => Partial<LlmResult>;
const tc = (name: string, args: Record<string, unknown>, id = `c-${crypto.randomUUID().slice(0, 6)}`) => ({ id, name, arguments: args });
const GOOD_PROMPT = "You are the assistant of Sunrise Dental. Answer only from the provided knowledge and hand over to a person for emergencies.";

describe.skipIf(!hasDb)("agent builder chat", () => {
  let app: ReturnType<typeof createApp>;
  let sh: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  let script: Script = () => ({ content: "hi" });
  let n0 = 0;
  let seen: LlmRequest[] = [];
  const ports = createMockPorts((req, n) => { seen.push(req); return script(req, ++n0); });

  beforeAll(async () => {
    const t = await setupTestDb();
    owner = t.owner; db = t.app; limiter = new MemoryRateLimiter();
    const open = (c: ReturnType<typeof testConfig>) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; };
    const log = createLogger({ level: "silent" });
    app = createApp({ cfg: testConfig({}, open), db, limiter, log, builderPorts: ports });
    sh = createApp({ cfg: testConfig({ DEPLOYMENT_MODE: "selfhosted" }, open), db, limiter, log, builderPorts: ports });
  });
  afterAll(async () => { limiter.close(); await db.end({ timeout: 2 }); await owner.end({ timeout: 2 }); });

  const call = (a: ReturnType<typeof createApp>, method: string, path: string, token: string | null, body?: unknown) =>
    a.request(`/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = async <T = any>(r: Response) => (await r.json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
  async function newTenant() {
    const s = await j<{ accessToken: string; tenant: { id: string } }>(await app.request("/api/v1/auth/register", json({ email: uniqueEmail("own"), password: PASSWORD, name: "Owner", workspaceName: "WS" })));
    return { token: s.accessToken, tenantId: s.tenant.id };
  }
  const start = async (t: { token: string }, a = app) => (await j(await call(a, "POST", "/agent-builder/sessions", t.token, {}))).id as string;
  const say = (t: { token: string }, id: string, body: unknown, a = app) => { n0 = 0; return call(a, "POST", `/agent-builder/sessions/${id}/messages`, t.token, body); };

  test("asks when info is missing, quick replies, repairs an invalid patch, finishes, creates a DRAFT only (limits + audit + metering)", async () => {
    const t = await newTenant();
    const id = await start(t);
    const s0 = await j(await call(app, "GET", `/agent-builder/sessions/${id}`, t.token));
    expect(s0).toMatchObject({ status: "open", draft: { ready: false, config: {} } });
    expect(s0.messages).toHaveLength(1);
    expect(s0.messages[0].role).toBe("assistant");

    // turn 1: the model does not know the hours => asks, with chips
    seen = [];
    script = (_r, n) => n === 1
      ? { toolCalls: [tc("update_draft", { patch: { name: "Sunrise helper" } }), tc("ask", { question: "What are your opening hours?", options: ["Weekdays 9-5", "I will write them"] })], usage: { promptTokens: 100, completionTokens: 20 }, model: "m1" }
      : { content: "unexpected" };
    const r1 = await j(await say(t, id, { text: "We run a dental clinic" }));
    expect(r1.assistant).toMatchObject({ role: "assistant", content: "What are your opening hours?", payload: { ask: { options: ["Weekdays 9-5", "I will write them"] } } });
    expect(r1.draft.name).toBe("Sunrise helper");
    expect(r1.ready).toBe(false);
    expect(seen[0]!.messages[0]!.content).toContain("NEVER invent business facts");

    // turn 2 (a quick-reply choice): invalid patch first, the model repairs it, then finish
    seen = [];
    script = (req, n) => {
      if (n === 1) return { toolCalls: [tc("update_draft", { patch: { config: { temperature: 9, model: "gpt-x" } } })], usage: { promptTokens: 200, completionTokens: 10 } };
      if (n === 2) {
        const tool = req.messages.filter((m) => m.role === "tool").at(-1)!;
        expect(JSON.parse(tool.content)).toMatchObject({ ok: false });
        expect(tool.content).toContain("model");
        return { toolCalls: [tc("update_draft", { patch: { description: "Books visits", config: { systemPrompt: GOOD_PROMPT, greeting: "Hi, welcome to Sunrise Dental!", escalationRules: { keywords: ["emergency"] }, enabledTools: ["qualify_lead", "book_appointment"] } } })], usage: { promptTokens: 200, completionTokens: 300 } };
      }
      if (n === 3) return { toolCalls: [tc("finish", { summary: "All set." })], usage: { promptTokens: 300, completionTokens: 5 } };
      return { content: "?" };
    };
    const r2 = await j(await say(t, id, { choice: "Weekdays 9-5" }));
    expect(r2.ready).toBe(true);
    expect(r2.assistant).toMatchObject({ content: "All set.", payload: { ready: true } });
    expect(r2.draft.config).toMatchObject({ greeting: "Hi, welcome to Sunrise Dental!", escalationRules: { keywords: ["emergency"] } });
    expect(r2.draft.config.model).toBeUndefined();

    // everything is persisted for reload (user, tool and assistant messages)
    const re = await j(await call(app, "GET", `/agent-builder/sessions/${id}`, t.token));
    expect(re.messages.map((m: { role: string }) => m.role).filter((x: string) => x === "tool").length).toBeGreaterThanOrEqual(4);
    expect(re.messages.some((m: { role: string; payload: { choice?: boolean } | null }) => m.role === "user" && m.payload?.choice)).toBe(true);
    expect(re.draft.ready).toBe(true);

    // metering: one builder row per LLM call, no agent attribution
    const ev = await owner`SELECT source, model, prompt_tokens, agent_id FROM ai_usage_events WHERE tenant_id = ${t.tenantId} ORDER BY at`;
    expect(ev.length).toBe(4);
    expect(ev.every((e) => e.source === "builder" && e.agent_id === null)).toBe(true);
    const [cr] = await owner`SELECT used_micro FROM tenant_credits WHERE tenant_id = ${t.tenantId}`;
    expect(Number(cr!.used_micro)).toBeGreaterThan(0);

    // create: draft only, created_via builder, audit
    const created = await call(app, "POST", `/agent-builder/sessions/${id}/create`, t.token, {});
    expect(created.status).toBe(201);
    const cj = await j(created);
    expect(cj.sandboxHint).toMatchObject({ path: `/agents/${cj.agentId}`, tab: "sandbox" });
    const ag = await j(await call(app, "GET", `/agents/${cj.agentId}`, t.token));
    expect(ag).toMatchObject({ status: "draft", publishedVersion: null, name: "Sunrise helper", description: "Books visits" });
    expect(ag.config.enabledTools).toEqual(["qualify_lead", "book_appointment"]);
    const [row] = await owner`SELECT created_via FROM agents WHERE id = ${cj.agentId}`;
    expect(row!.created_via).toBe("builder");
    expect((await owner`SELECT 1 FROM agent_versions WHERE agent_id = ${cj.agentId}`).length).toBe(0);
    expect((await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'agent.created' AND metadata->>'via' = 'builder'`).length).toBe(1);
    // closed session: no more messages, no second create
    expect((await say(t, id, { text: "more" })).status).toBe(409);
    expect((await call(app, "POST", `/agent-builder/sessions/${id}/create`, t.token, {})).status).toBe(409);
  });

  test("plan agent limit applies to create (402) and an incomplete draft is rejected (400)", async () => {
    const t = await newTenant(); // free plan: 1 agent
    expect((await call(app, "POST", "/agents", t.token, { name: "existing" })).status).toBe(201);
    const id = await start(t);
    expect((await call(app, "POST", `/agent-builder/sessions/${id}/create`, t.token, {})).status).toBe(400);
    script = (_r, n) => n === 1
      ? { toolCalls: [tc("update_draft", { patch: { name: "Second", config: { systemPrompt: GOOD_PROMPT, greeting: "Hello there" } } })] }
      : { content: "ok" };
    await say(t, id, { text: "go" });
    const over = await call(app, "POST", `/agent-builder/sessions/${id}/create`, t.token, {});
    expect(over.status).toBe(402);
    expect((await j(over)).error.code).toBe("plan_limit_exceeded");
    expect((await owner`SELECT count(*)::int AS n FROM agents WHERE tenant_id = ${t.tenantId}`)[0]!.n).toBe(1);
  });

  test("finish is refused until name, system prompt and greeting exist; plain-text replies are kept", async () => {
    const t = await newTenant();
    const id = await start(t);
    script = (req, n) => n === 1 ? { toolCalls: [tc("finish", {})] } : { content: `finish said: ${req.messages.filter((m) => m.role === "tool").at(-1)?.content}` };
    const r = await j(await say(t, id, { text: "done?" }));
    expect(r.ready).toBe(false);
    expect(r.assistant.content).toContain("Required before finishing");
  });

  test("create_knowledge_source adds a queued text source (audited); private URLs are refused", async () => {
    const t = await newTenant();
    const id = await start(t);
    script = (req, n) => {
      if (n === 1) return { toolCalls: [tc("create_knowledge_source", { type: "text", name: "Price list", content: "Cleaning costs what the owner pasted." }), tc("create_knowledge_source", { type: "url", name: "Local", url: "http://127.0.0.1/admin" })] };
      const tools = req.messages.filter((m) => m.role === "tool");
      return { content: `${tools.map((x) => JSON.parse(x.content).ok).join(",")}` };
    };
    const r = await j(await say(t, id, { text: "here is my price list" }));
    expect(r.assistant.content).toBe("true,false");
    expect(r.draft.knowledge).toHaveLength(1);
    const src = await owner`SELECT type, agent_id, status FROM knowledge_sources WHERE tenant_id = ${t.tenantId}`;
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({ type: "text", agent_id: null });
    expect((await owner`SELECT 1 FROM jobs WHERE tenant_id = ${t.tenantId} AND name = 'knowledge.ingest'`).length).toBe(1);
    expect((await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'knowledge.source.create' AND metadata->>'via' = 'builder'`).length).toBe(1);
  });

  test("credit gate: SaaS 402 credits_exhausted without calling the model; self-hosted records only", async () => {
    const t = await newTenant();
    const id = await start(t);
    await call(app, "GET", "/usage/credits", t.token);
    await owner`UPDATE tenant_credits SET used_micro = allowance_micro WHERE tenant_id = ${t.tenantId}`;
    seen = [];
    script = () => ({ content: "hello", usage: { promptTokens: 50, completionTokens: 5 } });
    const r = await say(t, id, { text: "hi" });
    expect(r.status).toBe(402);
    expect((await j(r)).error).toMatchObject({ code: "credits_exhausted" });
    expect(seen).toHaveLength(0);
    expect((await j(await call(app, "GET", `/agent-builder/sessions/${id}`, t.token))).messages).toHaveLength(1); // nothing persisted

    const s = await newTenant();
    const sid = await start(s, sh);
    await owner`UPDATE tenants SET plan_key = 'self_hosted' WHERE id = ${s.tenantId}`;
    const ok = await say(s, sid, { text: "hi" }, sh);
    expect(ok.status).toBe(200);
    const [ev] = await owner`SELECT source FROM ai_usage_events WHERE tenant_id = ${s.tenantId}`;
    expect(ev!.source).toBe("builder");
    const [cr] = await owner`SELECT coalesce(sum(used_micro),0) AS u FROM tenant_credits WHERE tenant_id = ${s.tenantId}`;
    expect(Number(cr!.u)).toBe(0);
  });

  test("validation, roles, rate limit and per-session caps", async () => {
    const t = await newTenant();
    const id = await start(t);
    expect((await say(t, id, {})).status).toBe(400);
    expect((await say(t, id, { text: "a", choice: "b" })).status).toBe(400);
    expect((await say(t, id, { text: "a", extra: 1 })).status).toBe(400);
    expect((await call(app, "POST", "/agent-builder/sessions", null, {})).status).toBe(401);
    // a viewer cannot use the builder
    const v = await owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t.tenantId}, ${uniqueEmail("v")}, 'V', 'viewer', 'x') RETURNING id`;
    const { signAccessToken } = await import("../src/security");
    const { SECRET } = await import("./helpers");
    const vt = await signAccessToken(SECRET, { userId: v[0]!.id, tenantId: t.tenantId, role: "viewer", ttlSeconds: 900 });
    expect((await call(app, "POST", "/agent-builder/sessions", vt, {})).status).toBe(403);
    // token cap
    await owner`UPDATE builder_sessions SET tokens_used = 999999 WHERE id = ${id}`;
    expect((await say(t, id, { text: "hi" })).status).toBe(429);
  });

  test("cross-tenant and cross-user: sessions are invisible (404) and unusable", async () => {
    const A = await newTenant();
    const B = await newTenant();
    const id = await start(A);
    for (const [m, p, b] of [["GET", `/agent-builder/sessions/${id}`, undefined], ["POST", `/agent-builder/sessions/${id}/messages`, { text: "x" }], ["POST", `/agent-builder/sessions/${id}/create`, {}]] as const) {
      expect((await call(app, m, p, B.token, b)).status).toBe(404);
    }
    // another admin of the SAME tenant cannot read someone else's session either
    const u = await owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${A.tenantId}, ${uniqueEmail("adm")}, 'Adm', 'admin', 'x') RETURNING id`;
    const { signAccessToken } = await import("../src/security");
    const { SECRET } = await import("./helpers");
    const at = await signAccessToken(SECRET, { userId: u[0]!.id, tenantId: A.tenantId, role: "admin", ttlSeconds: 900 });
    expect((await call(app, "GET", `/agent-builder/sessions/${id}`, at)).status).toBe(404);
    expect((await call(app, "GET", `/agent-builder/sessions/${id}`, A.token)).status).toBe(200);
    // RLS: the app role under tenant B sees none of A's rows
    const rows = await db.begin(async (tx) => { await tx`SELECT set_config('app.tenant_id', ${B.tenantId}, true)`; return tx`SELECT id FROM builder_sessions`; });
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });
});
