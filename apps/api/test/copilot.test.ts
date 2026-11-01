import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockPorts, type LlmRequest, type LlmResult } from "@yulona/ai-runtime";
import { hashPassword } from "../src/security";
import { SKIP_MESSAGE, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { PASSWORD, hasDb, json, testConfig, uniqueEmail } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

type Script = (req: LlmRequest, call: number) => Partial<LlmResult>;
const tc = (name: string, args: Record<string, unknown>, id = `c-${crypto.randomUUID().slice(0, 6)}`) => ({ id, name, arguments: args });

describe.skipIf(!hasDb)("onboarding, copilot and overview", () => {
  let app: ReturnType<typeof createApp>;
  let sh: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let limiter: MemoryRateLimiter;
  let script: Script = () => ({ content: "ok" });
  let calls: LlmRequest[] = [];
  const ports = createMockPorts((req) => { calls.push(req); return script(req, calls.length); });

  beforeAll(async () => {
    const t = await setupTestDb();
    owner = t.owner; db = t.app; limiter = new MemoryRateLimiter();
    const open = (c: ReturnType<typeof testConfig>) => { for (const k of Object.keys(c.rateLimits) as (keyof typeof c.rateLimits)[]) c.rateLimits[k] = { limit: 1e6, windowMs: 60_000 }; };
    const log = createLogger({ level: "silent" });
    app = createApp({ cfg: testConfig({ COPILOT_MODEL: "cheap-model" }, open), db, limiter, log, builderPorts: ports });
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
  async function pay(tenantId: string, plan = "pro", status = "active") {
    await owner`UPDATE tenants SET plan_key = ${plan} WHERE id = ${tenantId}`;
    await owner`INSERT INTO billing_customers (tenant_id, customer_id, status, plan_key) VALUES (${tenantId}, ${"cus_" + crypto.randomUUID().slice(0, 8)}, ${status}, ${plan})
                ON CONFLICT (tenant_id) DO UPDATE SET status = EXCLUDED.status, plan_key = EXCLUDED.plan_key`;
  }
  async function addUser(t: { token: string }, role: string) {
    const e = uniqueEmail(role);
    const inv = await j<{ inviteUrl: string }>(await call(app, "POST", "/invitations", t.token, { email: e, role }));
    await app.request("/api/v1/invitations/accept", json({ token: new URL(inv.inviteUrl).searchParams.get("token")!, name: "U", password: PASSWORD }));
    return (await j<{ accessToken: string }>(await app.request("/api/v1/auth/login", json({ email: e, password: PASSWORD })))).accessToken;
  }
  async function shTenant() {
    const [tn] = await owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('sh-' || substr(gen_random_uuid()::text, 1, 6)) RETURNING id`;
    const e = uniqueEmail("sh");
    await owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tn!.id}, ${e}, 'O', 'owner', ${await hashPassword(PASSWORD)})`;
    const token = (await j<{ accessToken: string }>(await sh.request("/api/v1/auth/login", json({ email: e, password: PASSWORD })))).accessToken;
    return { token, tenantId: tn!.id };
  }
  const answer = (t: { token: string }, stepId: string, value: unknown) => call(app, "PUT", "/onboarding/answers", t.token, { stepId, value });
  async function fillRequired(t: { token: string }, extra: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries({ businessType: "clinic", businessName: "Sunrise Dental", goals: ["bookings", "leads"], ...extra })) expect((await answer(t, k, v)).status).toBe(200);
  }

  // ------------------------------------------------------------------ profile
  test("workspace profile: goals validated, admin-only write, isolated per tenant", async () => {
    const a = await newTenant(), b = await newTenant();
    expect(await j(await call(app, "GET", "/workspace/profile", a.token))).toMatchObject({ goals: [], onboarding: { status: "not_started", completedAt: null } });
    expect((await call(app, "PUT", "/workspace/profile", a.token, { goals: ["nope"] })).status).toBe(400);
    expect((await call(app, "PUT", "/workspace/profile", a.token, { goals: ["leads", "leads"] })).status).toBe(400);
    expect((await call(app, "PUT", "/workspace/profile", a.token, { goals: ["leads"], extra: 1 })).status).toBe(400);
    expect(await j(await call(app, "PUT", "/workspace/profile", a.token, { goals: ["leads", "support"] }))).toMatchObject({ goals: ["leads", "support"] });
    expect((await j(await call(app, "GET", "/workspace/profile", b.token))).goals).toEqual([]);
    const viewer = await addUser(a, "viewer");
    expect((await call(app, "GET", "/workspace/profile", viewer)).status).toBe(200);
    expect((await call(app, "PUT", "/workspace/profile", viewer, { goals: ["support"] })).status).toBe(403);
    expect((await call(app, "GET", "/workspace/profile", null)).status).toBe(401);
    expect((await owner`SELECT 1 FROM audit_logs WHERE tenant_id = ${a.tenantId} AND action = 'workspace.profile.update'`).length).toBe(1);
  });

  // ------------------------------------------------------------------ onboarding wizard
  test("wizard: typed step schema, validation, suggestions per business type, resume, skip and resume", async () => {
    const t = await newTenant();
    const s0 = await j(await call(app, "GET", "/onboarding", t.token));
    expect(s0).toMatchObject({ status: "not_started", currentStepId: "businessType", progress: { done: 0, total: 10 } });
    expect(s0.steps.map((s: { id: string }) => s.id)).toEqual(["businessType", "businessName", "goals", "channels", "tone", "languages", "hours", "website", "brand", "handoff", "preview"]);
    const comps = new Set(["choice_cards", "multi_chips", "text", "url", "brand", "hours", "preview"]);
    expect(s0.steps.every((s: { component: string }) => comps.has(s.component))).toBe(true);

    expect((await answer(t, "businessType", "spaceship")).status).toBe(400);
    expect((await answer(t, "businessName", null)).status).toBe(400); // required
    expect((await answer(t, "goals", [])).status).toBe(400);
    expect((await answer(t, "brand", { color: "red" })).status).toBe(400);
    expect((await answer(t, "website", "javascript:alert(1)")).status).toBe(400);
    expect((await answer(t, "hours", { mode: "custom", timezone: "Mars/Base", days: [{ weekday: 1, start: "09:00", end: "17:00" }] })).status).toBe(400);
    expect((await answer(t, "hours", { mode: "custom", timezone: "UTC", days: [{ weekday: 1, start: "17:00", end: "09:00" }] })).status).toBe(400);
    expect((await answer(t, "preview", "x")).status).toBe(400);
    expect((await call(app, "PUT", "/onboarding/answers", t.token, { stepId: "nope", value: 1 })).status).toBe(400);

    const s1 = await j(await answer(t, "businessType", "restaurant"));
    expect(s1).toMatchObject({ status: "in_progress", currentStepId: "businessName", progress: { done: 1 } });
    const goalsStep = s1.steps.find((s: { id: string }) => s.id === "goals");
    expect(goalsStep.options.filter((o: { suggested?: boolean }) => o.suggested).map((o: { value: string }) => o.value).sort()).toEqual(["bookings", "support"]);

    // resume from another "device": answers persist server-side
    await answer(t, "businessName", "Cafe Lumi");
    expect(await j(await call(app, "GET", "/onboarding", t.token))).toMatchObject({ answers: { businessType: "restaurant", businessName: "Cafe Lumi" }, currentStepId: "goals" });

    // skip, then resume by answering again
    expect(await j(await call(app, "POST", "/onboarding/skip", t.token))).toMatchObject({ status: "skipped" });
    expect((await j(await call(app, "GET", "/workspace/profile", t.token))).onboarding.skippedAt).not.toBeNull();
    expect(await j(await answer(t, "goals", ["support"]))).toMatchObject({ status: "in_progress", currentStepId: "channels" });
    // an optional step can be skipped with null
    expect(await j(await answer(t, "channels", null))).toMatchObject({ currentStepId: "tone" });
    // finishing without the required answers fails
    const t2 = await newTenant();
    expect((await call(app, "POST", "/onboarding/finish", t2.token, {})).status).toBe(400);
    // roles: only admins
    const agent = await addUser(t, "agent");
    expect((await call(app, "GET", "/onboarding", agent)).status).toBe(403);
    expect((await call(app, "POST", "/onboarding/skip", agent)).status).toBe(403);
  });

  test("finish: template bundle + ONE capped model call, metered as onboarding and not charged; never published; idempotent; cross-tenant", async () => {
    const t = await newTenant();
    await fillRequired(t, { website: "https://example.com", brand: { color: "#2563EB" }, hours: { mode: "custom", timezone: "Africa/Addis_Ababa", days: [{ weekday: 1, start: "09:00", end: "17:00" }] }, handoff: "business_hours", tone: "professional" });
    calls = [];
    const POLISHED = "You are the friendly assistant of Sunrise Dental. Answer only from your knowledge, collect contact details of interested patients and hand over to a person for anything urgent.";
    script = () => ({ content: JSON.stringify({ systemPrompt: POLISHED, greeting: "Welcome to Sunrise Dental, how can I help?" }), usage: { promptTokens: 700, completionTokens: 150 }, model: "m-onb" });
    const [credBefore] = await owner`SELECT COALESCE(sum(used_micro),0) AS u FROM tenant_credits WHERE tenant_id = ${t.tenantId}`;
    const r = await call(app, "POST", "/onboarding/finish", t.token, {});
    expect(r.status).toBe(201);
    const res = await j(r);
    expect(res).toMatchObject({ usedModel: true, goals: ["bookings", "leads"], nextStep: { path: `/agents/${res.agentId}` } });
    expect(res.knowledgeSourceId).toBeTruthy();
    // exactly one capped call
    expect(calls.length).toBe(1);
    expect(calls[0]!.maxTokens).toBeLessThanOrEqual(700);
    expect(calls[0]!.messages.map((m) => m.content).join("").length).toBeLessThan(5200);
    expect(calls[0]!.tools).toBeUndefined();
    // bundle contents
    const ag = await j(await call(app, "GET", `/agents/${res.agentId}`, t.token));
    expect(ag).toMatchObject({ status: "draft", publishedVersion: null });
    expect(ag.config.systemPrompt).toBe(POLISHED);
    expect(ag.config.enabledTools).toEqual(expect.arrayContaining(["qualify_lead", "book_appointment", "escalate_to_human"]));
    const w = await j(await call(app, "GET", `/widgets/${res.widgetId}`, t.token));
    expect(w).toMatchObject({ agentId: res.agentId, config: { primaryColor: "#2563EB", welcomeMessage: "Welcome to Sunrise Dental, how can I help?" } });
    const [src] = await owner`SELECT crawl_config, type, source_url FROM knowledge_sources WHERE id = ${res.knowledgeSourceId}`;
    expect(src).toMatchObject({ type: "url", source_url: "https://example.com", crawl_config: { maxDepth: 3, followLinks: true, maxPages: 25 } });
    const ops = await j(await call(app, "GET", "/ops/settings", t.token));
    expect(ops).toMatchObject({ timezone: "Africa/Addis_Ababa", outOfHours: { mode: "message" }, businessHours: [{ weekday: 1, start: "09:00", end: "17:00" }] });
    expect(await j(await call(app, "GET", "/workspace/profile", t.token))).toMatchObject({ goals: ["bookings", "leads"], onboarding: { status: "completed" } });
    // metered as onboarding, credits NOT charged
    const ev = await owner`SELECT source, prompt_tokens, completion_tokens, credits_micro FROM ai_usage_events WHERE tenant_id = ${t.tenantId}`;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: "onboarding", prompt_tokens: 700 });
    expect(Number(ev[0]!.credits_micro)).toBeGreaterThan(0);
    const [credAfter] = await owner`SELECT COALESCE(sum(used_micro),0) AS u FROM tenant_credits WHERE tenant_id = ${t.tenantId}`;
    expect(Number(credAfter!.u)).toBe(Number(credBefore!.u));
    expect((await owner`SELECT action FROM audit_logs WHERE tenant_id = ${t.tenantId} AND metadata->>'via' = 'onboarding'`).length).toBeGreaterThanOrEqual(5);
    // idempotent: second finish = stored result, no second call, no second agent
    const again = await call(app, "POST", "/onboarding/finish", t.token, {});
    expect(again.status).toBe(200);
    expect((await j(again)).agentId).toBe(res.agentId);
    expect(calls.length).toBe(1);
    expect((await owner`SELECT 1 FROM agents WHERE tenant_id = ${t.tenantId}`).length).toBe(1);
    expect((await answer(t, "tone", "friendly")).status).toBe(409);
    // another tenant cannot see it
    const other = await newTenant();
    expect((await call(app, "GET", `/agents/${res.agentId}`, other.token)).status).toBe(404);
    expect((await j(await call(app, "GET", "/onboarding", other.token))).result).toBeNull();
  });

  test("finish: model failure, invalid output and missing provider fall back to the template text (still completes, one attempt)", async () => {
    for (const mode of ["throw", "garbage"] as const) {
      const t = await newTenant();
      await fillRequired(t);
      calls = [];
      script = () => { if (mode === "throw") throw new Error("provider down"); return { content: "not json at all", usage: { promptTokens: 10, completionTokens: 5 } }; };
      const r = await call(app, "POST", "/onboarding/finish", t.token, {});
      expect(r.status).toBe(201);
      const res = await j(r);
      expect(res.usedModel).toBe(false);
      expect(calls.length).toBe(1);
      const ag = await j(await call(app, "GET", `/agents/${res.agentId}`, t.token));
      expect(ag.config.systemPrompt).toContain("Sunrise Dental");
      expect(ag.config.greeting).toContain("Sunrise Dental");
      expect(ag.status).toBe("draft");
      const again = await call(app, "POST", "/onboarding/finish", t.token, {});
      expect(again.status).toBe(200);
      expect(calls.length).toBe(1); // never retried
    }
  });

  test("finish: a private website URL is skipped (SSRF), the rest of the bundle is still built", async () => {
    const t = await newTenant();
    await fillRequired(t, { website: "http://127.0.0.1:9/secret" });
    script = () => { throw new Error("down"); };
    const res = await j(await call(app, "POST", "/onboarding/finish", t.token, {}));
    expect(res.knowledgeSourceId).toBeNull();
    expect(res.agentId).toBeTruthy();
  });

  // ------------------------------------------------------------------ gating
  test("gating matrix: free, trialing-free, past_due, paying, self-hosted, over limit", async () => {
    const free = await newTenant();
    const st = await j(await call(app, "GET", "/copilot/status", free.token));
    expect(st).toMatchObject({ access: "locked", reason: "requires_plan", selfHosted: false });
    const lock = await call(app, "POST", "/copilot/sessions", free.token, {});
    expect(lock.status).toBe(402);
    expect((await j(lock)).error).toMatchObject({ code: "copilot_requires_plan", details: { upgradePath: "/settings/billing" } });

    const trial = await newTenant();
    await pay(trial.tenantId, "free", "trialing");
    expect((await call(app, "POST", "/copilot/sessions", trial.token, {})).status).toBe(402);
    const pastDue = await newTenant();
    await pay(pastDue.tenantId, "pro", "past_due");
    expect((await call(app, "POST", "/copilot/sessions", pastDue.token, {})).status).toBe(402);
    const canceled = await newTenant();
    await pay(canceled.tenantId, "pro", "canceled");
    expect((await call(app, "POST", "/copilot/sessions", canceled.token, {})).status).toBe(402);

    const paid = await newTenant();
    await pay(paid.tenantId);
    expect(await j(await call(app, "GET", "/copilot/status", paid.token))).toMatchObject({ access: "allowed", allowance: { limitCredits: 150, usedMicro: 0, remainingMicro: 150_000_000 } });
    const ok = await call(app, "POST", "/copilot/sessions", paid.token, {});
    expect(ok.status).toBe(201);
    const sid = (await j(ok)).id;

    // over the allowance: 402 copilot_limit_reached on messages and on a new session; chat credits untouched
    await owner`INSERT INTO ai_usage_events (tenant_id, source, model, prompt_tokens, completion_tokens, credits_micro) VALUES (${paid.tenantId}, 'copilot', 'm', 1, 1, 150000000)`;
    const over = await call(app, "POST", `/copilot/sessions/${sid}/messages`, paid.token, { text: "hello" });
    expect(over.status).toBe(402);
    expect((await j(over)).error).toMatchObject({ code: "copilot_limit_reached", details: { limitCredits: 150 } });
    expect((await call(app, "POST", "/copilot/sessions", paid.token, {})).status).toBe(402);
    expect(await j(await call(app, "GET", "/copilot/status", paid.token))).toMatchObject({ access: "allowed", allowance: { remainingMicro: 0 } });
    // the over-limit message was not stored
    expect((await owner`SELECT 1 FROM copilot_messages WHERE tenant_id = ${paid.tenantId} AND role = 'user'`).length).toBe(0);
    // the monthly metric is a plan limit the tenant endpoint shows, and chat credits are separate
    const lim = (await j(await call(app, "GET", "/tenant", paid.token))).limits.find((l: { metric: string }) => l.metric === "copilot_credits_monthly");
    expect(lim).toMatchObject({ limit: 150, used: 150 });

    // self-hosted: always allowed, never limited by the allowance
    const s = await shTenant();
    expect(await j(await call(sh, "GET", "/copilot/status", s.token))).toMatchObject({ access: "allowed", selfHosted: true, allowance: { limitCredits: null, remainingMicro: null } });
    const sid2 = (await j(await call(sh, "POST", "/copilot/sessions", s.token, {}))).id;
    await owner`INSERT INTO ai_usage_events (tenant_id, source, model, prompt_tokens, completion_tokens, credits_micro) VALUES (${s.tenantId}, 'copilot', 'm', 1, 1, 999000000)`;
    script = () => ({ content: "Sure.", usage: { promptTokens: 300, completionTokens: 20 } });
    expect((await call(sh, "POST", `/copilot/sessions/${sid2}/messages`, s.token, { text: "hi" })).status).toBe(200);
    const [cr] = await owner`SELECT COALESCE(sum(used_micro),0) AS u FROM tenant_credits WHERE tenant_id = ${s.tenantId}`;
    expect(Number(cr!.u)).toBe(0);
  });

  test("allowance is editable by the plan limit and a platform-set unlimited value never blocks", async () => {
    const t = await newTenant();
    await pay(t.tenantId, "enterprise");
    expect(await j(await call(app, "GET", "/copilot/status", t.token))).toMatchObject({ allowance: { limitCredits: 600 } });
    await owner`UPDATE plan_limits SET limit_value = NULL WHERE plan_key = 'enterprise' AND metric = 'copilot_credits_monthly'`;
    try {
      expect(await j(await call(app, "GET", "/copilot/status", t.token))).toMatchObject({ allowance: { limitCredits: null, remainingMicro: null } });
    } finally { await owner`UPDATE plan_limits SET limit_value = 600 WHERE plan_key = 'enterprise' AND metric = 'copilot_credits_monthly'`; }
    expect((await owner`SELECT limit_value FROM plan_limits WHERE plan_key = 'free' AND metric = 'copilot_credits_monthly'`)[0]!.limit_value).toBe("0");
  });

  // ------------------------------------------------------------------ copilot turns
  async function paidTenant() {
    const t = await newTenant();
    await pay(t.tenantId);
    const agent = await j(await call(app, "POST", "/agents", t.token, { name: "Helper" }));
    const sid = (await j(await call(app, "POST", "/copilot/sessions", t.token, {}))).id as string;
    return { ...t, agentId: agent.id as string, sid };
  }
  const say = (t: { token: string; sid: string }, text: string) => call(app, "POST", `/copilot/sessions/${t.sid}/messages`, t.token, { text });

  test("copilot updates an agent draft with validation, diff block, audit via copilot, metering without charge, low maxTokens and COPILOT_MODEL", async () => {
    const t = await paidTenant();
    calls = [];
    script = (req, n) => {
      if (n === 1) return { toolCalls: [tc("update_agent_draft", { agentId: t.agentId, config: { greeting: "Hello! Welcome.", model: "gpt-x" } })], usage: { promptTokens: 400, completionTokens: 40 } };
      if (n === 2) {
        const tool = req.messages.filter((m) => m.role === "tool").at(-1)!;
        expect(JSON.parse(tool.content)).toMatchObject({ ok: false });
        return { toolCalls: [tc("update_agent_draft", { agentId: t.agentId, config: { greeting: "Hello! Welcome." } })], usage: { promptTokens: 450, completionTokens: 40 } };
      }
      return { content: "Your greeting is updated (draft).", usage: { promptTokens: 480, completionTokens: 20 } };
    };
    const r = await j(await say(t, "make my greeting friendlier"));
    expect(r.assistant.content).toContain("greeting");
    expect(r.assistant.payload.blocks[0]).toMatchObject({ type: "diff", changes: [{ field: "greeting", after: "Hello! Welcome." }] });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.maxTokens! <= 600 && c.model === "cheap-model")).toBe(true);
    expect(calls[0]!.messages[0]!.content).toContain("Helper"); // compact workspace summary, ids only
    expect(calls[0]!.messages[0]!.content).not.toContain("systemPrompt");
    const ag = await j(await call(app, "GET", `/agents/${t.agentId}`, t.token));
    expect(ag.config.greeting).toBe("Hello! Welcome.");
    expect(ag.status).toBe("draft");
    const ev = await owner`SELECT source, agent_id FROM ai_usage_events WHERE tenant_id = ${t.tenantId}`;
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.source === "copilot" && e.agent_id === null)).toBe(true);
    const [cr] = await owner`SELECT COALESCE(sum(used_micro),0) AS u FROM tenant_credits WHERE tenant_id = ${t.tenantId}`;
    expect(Number(cr!.u)).toBe(0);
    const [au] = await owner`SELECT metadata FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'agent.updated' AND metadata->>'via' = 'copilot'`;
    expect(au!.metadata.sessionId).toBe(t.sid);
    // tool messages are not returned to the UI
    const re = await j(await call(app, "GET", `/copilot/sessions/${t.sid}`, t.token));
    expect(re.messages.every((m: { role: string }) => m.role !== "tool")).toBe(true);
  });

  test("max 3 tool rounds, then a deterministic wrap-up (no 4th call)", async () => {
    const t = await paidTenant();
    calls = [];
    script = () => ({ toolCalls: [tc("get_workspace_summary", {})], usage: { promptTokens: 100, completionTokens: 5 } });
    const r = await j(await say(t, "loop forever"));
    expect(calls).toHaveLength(3);
    expect(r.assistant.content.length).toBeGreaterThan(5);
  });

  test("publish is two-step: the model only proposes, the token is not in the model context, the user confirms once, and others cannot", async () => {
    const t = await paidTenant();
    script = (req, n) => n === 1
      ? { toolCalls: [tc("publish_agent", { agentId: t.agentId })], usage: { promptTokens: 300, completionTokens: 20 } }
      : { content: "Press Confirm on the card to publish.", usage: { promptTokens: 320, completionTokens: 15 } };
    calls = [];
    const r = await j(await say(t, "publish my agent"));
    const card = r.assistant.payload.blocks.find((b: { type: string }) => b.type === "confirm");
    expect(card.token.length).toBeGreaterThan(20);
    expect(JSON.stringify(calls)).not.toContain(card.token); // the model never sees the token
    expect((await j(await call(app, "GET", `/agents/${t.agentId}`, t.token))).status).toBe("draft"); // proposal did not publish
    expect((await owner`SELECT token_hash FROM copilot_pending_actions WHERE tenant_id = ${t.tenantId}`)[0]!.token_hash).not.toBe(card.token);

    // another user / session / tenant / forged token cannot confirm
    const other = await paidTenant();
    expect((await call(app, "POST", `/copilot/sessions/${other.sid}/confirm`, other.token, { token: card.token })).status).toBe(409);
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, other.token, { token: card.token })).status).toBe(409);
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, t.token, { token: "x".repeat(32) })).status).toBe(409);
    const adminB = await addUser(t, "admin");
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, adminB, { token: card.token })).status).toBe(409);
    // the model cannot confirm: no such tool
    const nt = await runTool(t, "confirm_action", { token: card.token });
    expect(nt.ok).toBe(false);

    const ok = await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, t.token, { token: card.token });
    expect(ok.status).toBe(200);
    expect((await j(ok)).message.content).toContain("Published");
    const ag = await j(await call(app, "GET", `/agents/${t.agentId}`, t.token));
    expect(ag).toMatchObject({ status: "published", publishedVersion: 1 });
    expect((await owner`SELECT metadata FROM audit_logs WHERE tenant_id = ${t.tenantId} AND action = 'agent.published'`)[0]!.metadata).toMatchObject({ via: "copilot", sessionId: t.sid });
    // single use
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, t.token, { token: card.token })).status).toBe(409);
  });

  test("pending actions expire and can be cancelled", async () => {
    const t = await paidTenant();
    calls = [];
    script = (_r, n) => n % 2 === 1 ? { toolCalls: [tc("publish_agent", { agentId: t.agentId })] } : { content: "Confirm to publish." };
    const tok1 = (await j(await say(t, "publish"))).assistant.payload.blocks[0].token;
    await owner`UPDATE copilot_pending_actions SET expires_at = now() - interval '1 minute' WHERE tenant_id = ${t.tenantId}`;
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, t.token, { token: tok1 })).status).toBe(409);
    const tok2 = (await j(await say(t, "publish again"))).assistant.payload.blocks[0].token;
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/cancel`, t.token, { token: tok2 })).status).toBe(200);
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/confirm`, t.token, { token: tok2 })).status).toBe(409);
    expect((await j(await call(app, "GET", `/agents/${t.agentId}`, t.token))).status).toBe("draft");
  });

  async function runTool(t: { tenantId: string; sid: string }, name: string, args: Record<string, unknown>, role: "viewer" | "agent" | "admin" | "owner" = "owner") {
    const { runCopilotTool } = await import("../src/copilot/tools");
    const [u] = await owner`SELECT id FROM users WHERE tenant_id = ${t.tenantId} LIMIT 1`;
    return runCopilotTool({ db, tenantId: t.tenantId, userId: u!.id, role, sessionId: t.sid }, name, args);
  }

  test("tool role checks: viewer/agent get read-only tools; unknown tools and bad ids are rejected; cross-tenant ids are not found", async () => {
    const t = await paidTenant(), other = await paidTenant();
    expect((await runTool(t, "get_workspace_summary", {}, "viewer")).ok).toBe(true);
    expect((await runTool(t, "list_channel_status", {}, "agent")).ok).toBe(true);
    for (const role of ["viewer", "agent"] as const) {
      expect((await runTool(t, "update_agent_draft", { agentId: t.agentId, name: "x" }, role)).ok).toBe(false);
      expect((await runTool(t, "set_goals", { goals: ["leads"] }, role)).ok).toBe(false);
      expect((await runTool(t, "publish_agent", { agentId: t.agentId }, role)).ok).toBe(false);
    }
    expect((await j(await call(app, "GET", `/agents/${t.agentId}`, t.token))).name).toBe("Helper");
    expect((await runTool(t, "update_agent_draft", { agentId: "nope", name: "x" })).ok).toBe(false);
    expect((await runTool(t, "update_agent_draft", { agentId: other.agentId, name: "hijack" })).ok).toBe(false);
    expect((await j(await call(app, "GET", `/agents/${other.agentId}`, other.token))).name).toBe("Helper");
    expect((await runTool(t, "publish_agent", { agentId: other.agentId })).ok).toBe(false);
    expect((await runTool(t, "drop_database", {})).ok).toBe(false);
    // routes: viewers and agents cannot open the copilot at all
    const viewer = await addUser(t, "viewer");
    expect((await call(app, "GET", "/copilot/status", viewer)).status).toBe(403);
    expect((await call(app, "POST", "/copilot/sessions", viewer, {})).status).toBe(403);
    // sessions are private to their user
    const adminB = await addUser(t, "admin");
    expect((await call(app, "GET", `/copilot/sessions/${t.sid}`, adminB)).status).toBe(404);
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/messages`, adminB, { text: "x" })).status).toBe(404);
  });

  test("tools: widget look, hours, goals, knowledge (SSRF + per-session cap), forbidden keys, summary has no secrets/knowledge text", async () => {
    const t = await paidTenant();
    const w = await j(await call(app, "POST", "/widgets", t.token, { name: "Site", agentId: t.agentId }));
    const wr = await runTool(t, "update_widget_appearance", { primaryColor: "#112233", title: "Hi there" });
    expect(wr.ok).toBe(true);
    expect((await j(await call(app, "GET", `/widgets/${w.id}`, t.token))).config).toMatchObject({ primaryColor: "#112233", title: "Hi there" });
    expect((await runTool(t, "update_widget_appearance", { primaryColor: "red" })).ok).toBe(false);
    expect((await runTool(t, "set_business_hours", { timezone: "Africa/Nairobi", days: [{ weekday: 2, start: "08:00", end: "12:00" }] })).ok).toBe(true);
    expect((await j(await call(app, "GET", "/ops/settings", t.token))).businessHours).toEqual([{ weekday: 2, start: "08:00", end: "12:00" }]);
    expect((await runTool(t, "set_business_hours", { days: [{ weekday: 2, start: "12:00", end: "08:00" }] })).ok).toBe(false);
    expect((await runTool(t, "set_goals", { goals: ["bookings"] })).ok).toBe(true);
    expect((await j(await call(app, "GET", "/workspace/profile", t.token))).goals).toEqual(["bookings"]);
    expect((await runTool(t, "add_knowledge_url", { url: "http://169.254.169.254/latest" })).ok).toBe(false);
    expect((await runTool(t, "add_knowledge_url", { url: "https://example.com", depth: 9 })).ok).toBe(false);
    expect((await runTool(t, "add_knowledge_url", { url: "https://example.com", depth: 2, maxPages: 10 })).ok).toBe(true);
    expect((await runTool(t, "add_knowledge_url", { url: "https://example.org" })).ok).toBe(true);
    expect((await runTool(t, "add_knowledge_url", { url: "https://example.net" })).ok).toBe(false); // session cap
    const [src] = await owner`SELECT crawl_config FROM knowledge_sources WHERE tenant_id = ${t.tenantId} ORDER BY created_at LIMIT 1`;
    expect(src!.crawl_config).toMatchObject({ maxDepth: 2, maxPages: 10 });
    expect((await runTool(t, "update_agent_draft", { agentId: t.agentId, config: { customTools: [], topK: 3 } })).ok).toBe(false);
    expect((await runTool(t, "update_agent_draft", { agentId: t.agentId, config: { enabledTools: ["rm_rf"] } })).ok).toBe(false);
    await owner`UPDATE channel_connections SET credentials_encrypted = 'SECRET' WHERE tenant_id = ${t.tenantId}`;
    const sum = JSON.stringify((await runTool(t, "get_workspace_summary", {})).reply);
    expect(sum).not.toContain("SECRET");
    expect(sum).not.toContain("credentials");
    const audits = await owner`SELECT action FROM audit_logs WHERE tenant_id = ${t.tenantId} AND metadata->>'via' = 'copilot'`;
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["widget.update", "ops_settings.update", "workspace.profile.update", "knowledge.source.create"]));
  });

  test("DB-backed in-flight guard, per-session cap and invalid bodies", async () => {
    const t = await paidTenant();
    await owner`UPDATE copilot_sessions SET busy_until = now() + interval '60 seconds' WHERE id = ${t.sid}`;
    expect((await say(t, "hi")).status).toBe(409);
    await owner`UPDATE copilot_sessions SET busy_until = now() - interval '1 second' WHERE id = ${t.sid}`; // stale lock (crashed process) expires on its own
    script = () => ({ content: "Hello." });
    expect((await say(t, "hi")).status).toBe(200);
    expect((await owner`SELECT busy_until FROM copilot_sessions WHERE id = ${t.sid}`)[0]!.busy_until).toBeNull();
    // failed provider still releases the flag
    script = () => { throw new Error("down"); };
    expect((await say(t, "again")).status).toBe(503);
    expect((await owner`SELECT busy_until FROM copilot_sessions WHERE id = ${t.sid}`)[0]!.busy_until).toBeNull();
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/messages`, t.token, { text: "a", choice: "b" })).status).toBe(400);
    expect((await call(app, "POST", `/copilot/sessions/${t.sid}/messages`, t.token, {})).status).toBe(400);
    // per-session message cap and token cap
    await owner`UPDATE copilot_sessions SET tokens_used = 60000 WHERE id = ${t.sid}`;
    expect((await say(t, "x")).status).toBe(429);
    await owner`UPDATE copilot_sessions SET tokens_used = 0 WHERE id = ${t.sid}`;
    for (let i = 0; i < 40; i++) await owner`INSERT INTO copilot_messages (tenant_id, session_id, role, content) VALUES (${t.tenantId}, ${t.sid}, 'user', 'm')`;
    expect((await say(t, "x")).status).toBe(429);
  });

  test("per-month workspace message cap and suggest_next_steps blocks", async () => {
    const t = await paidTenant();
    calls = [];
    script = (_r, n) => n === 1 ? { toolCalls: [tc("suggest_next_steps", {})] } : { content: "Here is what is next." };
    const r = await j(await say(t, "what next?"));
    const types = r.assistant.payload.blocks.map((b: { type: string }) => b.type);
    expect(types).toContain("checklist");
    expect(types).toContain("chips");
    // monthly cap (500) across sessions
    const [u] = await owner`SELECT id FROM users WHERE tenant_id = ${t.tenantId} LIMIT 1`;
    const [s2] = await owner`INSERT INTO copilot_sessions (tenant_id, user_id, status) VALUES (${t.tenantId}, ${u!.id}, 'closed') RETURNING id`;
    await owner`INSERT INTO copilot_messages (tenant_id, session_id, role, content) SELECT ${t.tenantId}, ${s2!.id}, 'user', 'm' FROM generate_series(1, 500)`;
    expect((await say(t, "one more")).status).toBe(429);
  });

  // ------------------------------------------------------------------ overview
  test("overview: empty goals, goal blocks computed from the tenant's own data, isolation, viewer can read", async () => {
    const t = await newTenant();
    const o0 = await j(await call(app, "GET", "/overview", t.token));
    expect(o0).toMatchObject({ goals: [], order: [], common: { conversations: { last30d: 0, open: 0, today: 0 }, setup: { doneCount: 0, total: 4 } } });
    expect(o0.support).toBeUndefined();

    const agent = await j(await call(app, "POST", "/agents", t.token, { name: "A" }));
    const widget = await j(await call(app, "POST", "/widgets", t.token, { name: "W", agentId: agent.id }));
    await call(app, "PUT", "/workspace/profile", t.token, { goals: ["leads", "support", "bookings"] });
    const [contact] = await owner`INSERT INTO contacts (tenant_id, name) VALUES (${t.tenantId}, 'C') RETURNING id`;
    const mkConv = async (opts: { handoff?: "uncertainty" | "stage"; stages?: string[]; msgs?: boolean }) => {
      const [c] = await owner`INSERT INTO conversations (tenant_id, contact_id, channel, widget_id, agent_id, last_customer_message_at) VALUES (${t.tenantId}, ${contact!.id}, 'widget', ${widget.id}, ${agent.id}, now()) RETURNING id`;
      if (opts.msgs !== false) {
        await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, created_at) VALUES (${t.tenantId}, ${c!.id}, 'contact', 'hi', now() - interval '60 seconds')`;
        await owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content, created_at) VALUES (${t.tenantId}, ${c!.id}, 'ai', 'hello', now() - interval '50 seconds')`;
      }
      if (opts.handoff) await owner`INSERT INTO handoffs (tenant_id, conversation_id, type, reason) VALUES (${t.tenantId}, ${c!.id}, ${opts.handoff}, 'r')`;
      for (const s of opts.stages ?? []) await owner`INSERT INTO stage_transitions (tenant_id, conversation_id, from_stage, to_stage) VALUES (${t.tenantId}, ${c!.id}, 'visitor', ${s})`;
      return c!.id as string;
    };
    await mkConv({ stages: ["engaged", "qualified"] });
    await mkConv({ handoff: "uncertainty", stages: ["engaged"] });
    const bookedConv = await mkConv({ stages: ["engaged", "qualified", "booked"] });
    await mkConv({});
    await owner`INSERT INTO bookings (tenant_id, status, title, start_at, end_at, conversation_id) VALUES (${t.tenantId}, 'booked', 'B1', now() + interval '1 day', now() + interval '1 day 1 hour', ${bookedConv})`;
    await owner`INSERT INTO bookings (tenant_id, status, title, start_at, end_at, cancelled_at) VALUES (${t.tenantId}, 'cancelled', 'B2', now() + interval '2 day', now() + interval '2 day 1 hour', now())`;
    await owner`INSERT INTO calendar_connections (tenant_id, provider, status, is_default, credentials_encrypted) VALUES (${t.tenantId}, 'calendly', 'active', true, 'x')`;
    await owner`INSERT INTO crm_connections (tenant_id, provider, token_encrypted, status, last_sync_at) VALUES (${t.tenantId}, 'hubspot', 'x', 'active', now())`;
    await owner`INSERT INTO crm_sync_log (tenant_id, provider, trigger, status) VALUES (${t.tenantId}, 'hubspot', 'qualified', 'failed')`;

    // keep this file's handoff notifications out of the shared pending-email queue (other suites dispatch it globally)
    await owner`UPDATE notifications SET email_status = 'none' WHERE tenant_id = ${t.tenantId} AND email_status = 'pending'`;
    const o = await j(await call(app, "GET", "/overview", t.token));
    expect(o.order).toEqual(["leads", "support", "bookings"]);
    expect(o.common).toMatchObject({ conversations: { last30d: 4, open: 4, today: 4 }, channels: { total: 0 }, setup: { total: 4 } });
    expect(o.common.setup.items.find((i: { key: string }) => i.key === "agent").done).toBe(true);
    expect(o.support).toMatchObject({ handoffs: 1, medianFirstResponseSeconds: 10, unanswered: { count: 1 } });
    expect(o.support.aiResolvedPct).toBe(75);
    expect(o.support.unanswered.items).toHaveLength(1);
    expect(o.leads.funnel).toEqual([{ stage: "visitor", count: 4 }, { stage: "engaged", count: 3 }, { stage: "qualified", count: 2 }, { stage: "booking_offered", count: 0 }, { stage: "booked", count: 1 }]);
    expect(o.leads).toMatchObject({ qualified: 2, hubspot: { connected: true, failed: 1 } });
    expect(o.bookings).toMatchObject({ upcoming: 1, booked30d: 1, cancelled30d: 1, calendar: { connected: true, provider: "calendly" } });

    // goals gate the blocks
    await call(app, "PUT", "/workspace/profile", t.token, { goals: ["support"] });
    const o2 = await j(await call(app, "GET", "/overview", t.token));
    expect(o2.leads).toBeUndefined(); expect(o2.bookings).toBeUndefined(); expect(o2.support).toBeDefined();
    // isolation: another tenant sees nothing of it
    const b = await newTenant();
    await call(app, "PUT", "/workspace/profile", b.token, { goals: ["support", "leads", "bookings"] });
    const ob = await j(await call(app, "GET", "/overview", b.token));
    expect(ob.common.conversations.last30d).toBe(0);
    expect(ob.support).toMatchObject({ handoffs: 0, aiResolvedPct: null, medianFirstResponseSeconds: null, unanswered: { count: 0, items: [] } });
    expect(ob.leads).toMatchObject({ qualified: 0, hubspot: { connected: false, failed: 0 } });
    expect(ob.bookings).toMatchObject({ upcoming: 0, calendar: { connected: false } });
    // viewers can read it
    expect((await call(app, "GET", "/overview", await addUser(t, "viewer"))).status).toBe(200);
    expect((await call(app, "GET", "/overview", null)).status).toBe(401);
  });
});
