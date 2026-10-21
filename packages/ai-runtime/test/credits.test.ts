import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "@yulona/db";
import { SKIP_MESSAGE, testUrls } from "@yulona/db/testing";
import { encryptJson } from "@yulona/crypto";
import { createLlmResolver, portsFromResolver, profileAad } from "../src/llm-resolver";
import { createMockPorts } from "../src/mock";
import { handleInboundMessage } from "../src/runtime";
import { runSandbox } from "../src/sandbox";
import { CreditsExhaustedError, addUsage, computeCostMicro } from "../src/usage";
import { addCustomerMessage, seedAgent, seedConversation, seedTenant, setupAiDb, type TestEnv } from "./helpers";

const enabled = !!testUrls();
if (!enabled) console.warn(SKIP_MESSAGE);
const d = enabled ? describe : describe.skip;

let env: TestEnv;
beforeAll(async () => { if (enabled) env = (await setupAiDb())!; });
afterAll(async () => { if (enabled) await env.close(); });

const KEY = "0123456789abcdef".repeat(4);
const FREE_MICRO = 50_000_000;

async function seedOwnerUser(tenantId: string, role = "owner") {
  await env.owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${tenantId}, ${`u-${crypto.randomUUID().slice(0, 8)}@example.test`}, 'U', ${role}, 'x')`;
}
const credits = async (tenantId: string) =>
  (await env.owner<{ usedMicro: string; topupMicro: string; topupUsedMicro: string; allowanceMicro: string | null; warned80At: Date | null; exhaustedNotifiedAt: Date | null }[]>`
    SELECT used_micro, topup_micro, topup_used_micro, allowance_micro, warned_80_at, exhausted_notified_at FROM tenant_credits WHERE tenant_id = ${tenantId} AND period = date_trunc('month', now() AT TIME ZONE 'UTC')::date`)[0]!;
const consume = (tenantId: string, micro: number) => withTenant(env.app, tenantId, (tx) => tx`SELECT consume_credits(${tenantId}::uuid, ${micro}::bigint)`);
const notifCount = async (tenantId: string, type: string) =>
  (await env.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = ${tenantId} AND type = ${type}`)[0]!.n;

describe("micro-credit math", () => {
  const rate = { inputMicroPer1k: 250_000, outputMicroPer1k: 1_000_000 };
  test("cost = ceil((prompt*in + completion*out) / 1000) micro-credits", () => {
    expect(computeCostMicro(rate, 1000, 0)).toBe(250_000); // 0.25 credit per 1k input tokens
    expect(computeCostMicro(rate, 0, 1000)).toBe(1_000_000); // 1 credit per 1k output tokens
    expect(computeCostMicro(rate, 1, 0)).toBe(250);
    expect(computeCostMicro(rate, 1200, 300)).toBe(300_000 + 300_000);
    expect(computeCostMicro({ inputMicroPer1k: 100, outputMicroPer1k: 0 }, 3, 0)).toBe(1); // rounds up, never free
    expect(computeCostMicro(rate, 0, 0)).toBe(0);
    expect(computeCostMicro({ inputMicroPer1k: 1e12, outputMicroPer1k: 1e12 }, 1e6, 1e6)).toBe(2e15); // no float drift at the top end
  });
});

d("consume_credits", () => {
  test("monthly allowance first, then the top-up balance; unlimited plans never run out", async () => {
    const t = await seedTenant(env.owner);
    await consume(t, 49_000_000);
    expect(await credits(t)).toMatchObject({ allowanceMicro: String(FREE_MICRO), usedMicro: "49000000", topupMicro: "0" });
    await env.owner`UPDATE tenant_credits SET topup_micro = 10000000 WHERE tenant_id = ${t}`;
    await consume(t, 3_000_000); // 1M from the allowance, 2M from the top-up
    expect(await credits(t)).toMatchObject({ usedMicro: String(FREE_MICRO), topupMicro: "8000000", topupUsedMicro: "2000000" });
    await consume(t, 1_000_000); // allowance is gone: straight to the top-up
    expect(await credits(t)).toMatchObject({ usedMicro: String(FREE_MICRO), topupMicro: "7000000" });
    const ent = await seedTenant(env.owner);
    await env.owner`UPDATE tenants SET plan_key = 'enterprise' WHERE id = ${ent}`;
    await consume(ent, 999_000_000);
    const row = await credits(ent);
    expect(row.allowanceMicro).toBeNull();
    const [gate] = await withTenant(env.app, ent, (tx) => tx<{ creditsGate: string | null }[]>`SELECT credits_gate(${ent}::uuid)`);
    expect(gate!.creditsGate).toBeNull();
  });

  test("atomic under concurrency: 40 parallel consumers add up exactly", async () => {
    const t = await seedTenant(env.owner);
    await withTenant(env.app, t, (tx) => tx`SELECT credits_gate(${t}::uuid)`);
    await Promise.all(Array.from({ length: 40 }, () => consume(t, 1_000_000)));
    expect(await credits(t)).toMatchObject({ usedMicro: "40000000", topupMicro: "0" });
    // and across the allowance/top-up boundary nothing is lost or double counted
    await env.owner`UPDATE tenant_credits SET used_micro = 45000000, topup_micro = 100000000 WHERE tenant_id = ${t}`;
    await Promise.all(Array.from({ length: 30 }, () => consume(t, 1_000_000)));
    const row = await credits(t);
    expect(Number(row.usedMicro)).toBe(FREE_MICRO);
    expect(Number(row.topupMicro)).toBe(100_000_000 - 25_000_000);
    expect(Number(row.topupUsedMicro)).toBe(25_000_000);
  });

  test("80% and 100% notices fire once per period each", async () => {
    const t = await seedTenant(env.owner);
    await seedOwnerUser(t);
    await seedOwnerUser(t, "admin");
    await consume(t, 39_000_000); // 78%
    expect(await notifCount(t, "credits.warning_80")).toBe(0);
    await consume(t, 2_000_000); // 82%
    await consume(t, 1_000_000);
    expect(await notifCount(t, "credits.warning_80")).toBe(2); // one per owner/admin, not per call
    await consume(t, 8_000_000); // 100%
    await consume(t, 5_000_000);
    expect(await notifCount(t, "credits.exhausted")).toBe(2);
  });

  test("credits_rollover opens the new period carrying the top-up balance", async () => {
    const t = await seedTenant(env.owner);
    await env.owner`INSERT INTO tenant_credits (tenant_id, period, allowance_micro, used_micro, topup_micro)
                    VALUES (${t}, (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, ${FREE_MICRO}, ${FREE_MICRO}, 5000000)`;
    const [r] = await env.app<{ creditsRollover: number }[]>`SELECT credits_rollover()`;
    expect(r!.creditsRollover).toBeGreaterThanOrEqual(1);
    expect(await credits(t)).toMatchObject({ usedMicro: "0", topupMicro: "5000000", allowanceMicro: String(FREE_MICRO) });
  });
});

d("addUsage events", () => {
  test("records an event with attribution + cost, charges in SaaS, records but never charges when charge=false", async () => {
    const t = await seedTenant(env.owner);
    const agent = await seedAgent(env.owner, t);
    await env.owner`INSERT INTO llm_model_rates (model, input_micro_per_1k, output_micro_per_1k) VALUES ('fancy-1', 1000000, 2000000)`;
    const r1 = await withTenant(env.app, t, (tx) => addUsage(tx, t, { promptTokens: 1000, completionTokens: 500, requests: 1, agentId: agent, source: "builder", model: "fancy-1", charge: true }));
    expect(r1.creditsMicro).toBe(2_000_000); // 1 credit in + 1 credit out
    const r2 = await withTenant(env.app, t, (tx) => addUsage(tx, t, { promptTokens: 1000, completionTokens: 0, requests: 1, source: "tool_test", model: "unknown-model", charge: false }));
    expect(r2.creditsMicro).toBe(250_000); // falls back to the * rate
    const ev = await env.owner<{ source: string; model: string; agentId: string | null; creditsMicro: string }[]>`SELECT source, model, agent_id, credits_micro FROM ai_usage_events WHERE tenant_id = ${t} ORDER BY at`;
    expect(ev.map((e) => [e.source, e.model, e.creditsMicro])).toEqual([["builder", "fancy-1", "2000000"], ["tool_test", "unknown-model", "250000"]]);
    expect(ev[0]!.agentId).toBe(agent);
    expect((await credits(t)).usedMicro).toBe("2000000"); // only the charged call
    expect((await env.owner`SELECT sum(amount)::int AS n FROM ai_usage WHERE tenant_id = ${t} AND kind = 'llm_requests'`)[0]!.n).toBe(2);
  });
});

d("gate", () => {
  const exhaust = async (t: string) => {
    await withTenant(env.app, t, (tx) => tx`SELECT credits_gate(${t}::uuid)`);
    await env.owner`UPDATE tenant_credits SET used_micro = allowance_micro WHERE tenant_id = ${t}`;
  };

  test("SaaS exhausted: no model call, system_failure handoff ai_credits_exhausted, customer-safe notice, ONE admin notification", async () => {
    const t = await seedTenant(env.owner);
    await seedOwnerUser(t);
    const agent = await seedAgent(env.owner, t);
    await exhaust(t);
    const ports = createMockPorts();
    const deps = { db: env.app, ports, credits: { enabled: true, exhaustedMessage: "We are out of credits, a person will help." } };
    const c1 = await seedConversation(env.owner, t, agent, "what are your hours?");
    const r1 = await handleInboundMessage(deps, { tenantId: t, conversationId: c1.conversationId, messageId: c1.messageId });
    expect(r1.status).toBe("handoff");
    expect(ports.llm.calls).toHaveLength(0);
    const [h] = await env.owner<{ type: string; reason: string }[]>`SELECT type, reason FROM handoffs WHERE conversation_id = ${c1.conversationId}`;
    expect(h).toMatchObject({ type: "system_failure", reason: "ai_credits_exhausted" });
    const [m] = await env.owner<{ content: string }[]>`SELECT content FROM messages WHERE conversation_id = ${c1.conversationId} AND sender_type = 'ai'`;
    expect(m!.content).toContain("We are out of credits, a person will help.");
    // a second customer is gated too, but the admin is told only once for the period
    const c2 = await seedConversation(env.owner, t, agent, "hello?");
    await handleInboundMessage(deps, { tenantId: t, conversationId: c2.conversationId, messageId: c2.messageId });
    expect(ports.llm.calls).toHaveLength(0);
    expect(await notifCount(t, "credits.exhausted")).toBe(1);
    expect((await env.owner`SELECT count(*)::int AS n FROM ai_usage_events WHERE tenant_id = ${t}`)[0]!.n).toBe(0);
  });

  test("buying credits lifts the gate; a model call is charged and attributed to the conversation", async () => {
    const t = await seedTenant(env.owner);
    const agent = await seedAgent(env.owner, t);
    await exhaust(t);
    await env.owner`UPDATE tenant_credits SET topup_micro = 5000000 WHERE tenant_id = ${t}`;
    const ports = createMockPorts(() => ({ content: "Hi there", usage: { promptTokens: 2000, completionTokens: 1000 }, model: "gpt-test" }));
    const c = await seedConversation(env.owner, t, agent, "hello");
    const r = await handleInboundMessage({ db: env.app, ports, credits: { enabled: true } }, { tenantId: t, conversationId: c.conversationId, messageId: c.messageId });
    expect(r.status).toBe("replied");
    const [ev] = await env.owner<{ model: string; conversationId: string; agentId: string; source: string; creditsMicro: string }[]>`
      SELECT model, conversation_id, agent_id, source, credits_micro FROM ai_usage_events WHERE tenant_id = ${t}`;
    expect(ev).toMatchObject({ model: "gpt-test", conversationId: c.conversationId, agentId: agent, source: "turn", creditsMicro: String(500_000 + 1_000_000) });
    expect(await credits(t)).toMatchObject({ topupMicro: String(5_000_000 - 1_500_000) });
  });

  test("self-hosted (credits.enabled=false): never gates, never charges, still records usage", async () => {
    const t = await seedTenant(env.owner);
    const agent = await seedAgent(env.owner, t);
    await exhaust(t);
    const ports = createMockPorts(() => ({ content: "ok", usage: { promptTokens: 100, completionTokens: 100 } }));
    const c = await seedConversation(env.owner, t, agent, "hello");
    const r = await handleInboundMessage({ db: env.app, ports, credits: { enabled: false } }, { tenantId: t, conversationId: c.conversationId, messageId: c.messageId });
    expect(r.status).toBe("replied");
    expect(ports.llm.calls).toHaveLength(1);
    expect((await credits(t)).usedMicro).toBe(String(FREE_MICRO)); // unchanged
    const [ev] = await env.owner<{ creditsMicro: string }[]>`SELECT credits_micro FROM ai_usage_events WHERE tenant_id = ${t}`;
    expect(Number(ev!.creditsMicro)).toBeGreaterThan(0);
  });

  test("sandbox refuses with CreditsExhaustedError in SaaS and runs in self-hosted", async () => {
    const t = await seedTenant(env.owner);
    const agent = await seedAgent(env.owner, t);
    await exhaust(t);
    const ports = createMockPorts(() => ({ content: "sandbox ok", usage: { promptTokens: 10, completionTokens: 10 } }));
    await expect(runSandbox({ db: env.app, ports, credits: { enabled: true } }, { tenantId: t, agentId: agent, message: "hi" })).rejects.toBeInstanceOf(CreditsExhaustedError);
    expect(ports.llm.calls).toHaveLength(0);
    const out = await runSandbox({ db: env.app, ports, credits: { enabled: false } }, { tenantId: t, agentId: agent, message: "hi" });
    expect(out!.answer).toContain("sandbox ok");
    const [ev] = await env.owner<{ source: string }[]>`SELECT source FROM ai_usage_events WHERE tenant_id = ${t}`;
    expect(ev!.source).toBe("sandbox");
  });
});

d("LlmResolver", () => {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fakeFetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return Response.json({ model: calls.at(-1)!.body.model, choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  }) as unknown as typeof fetch;
  const publicDns = async () => ["93.184.216.34"];

  async function insertProfile(over: { baseUrl?: string; models?: string[]; apiKey?: string } = {}) {
    const id = crypto.randomUUID();
    await env.owner`DELETE FROM llm_provider_profiles`;
    await env.owner`
      SELECT sa_create_llm_profile(NULL, ${id}, ${"p-" + id.slice(0, 6)}, ${over.baseUrl ?? "https://llm.example.com/v1"}, 'api-key', 'raw', '{"x-org":"acme"}', '{"api-version":"2024-06-01"}',
        '/deployments/x/chat/completions', ${encryptJson(KEY, { apiKey: over.apiKey ?? "sekret-key-123" }, profileAad(id))}, 'model-default', ${env.owner.array(over.models ?? ["model-a"])}, true, true)`;
    return id;
  }

  test("SaaS: default profile drives the call (auth header, extra headers, query, path); only enabled models are used, with fallback noted", async () => {
    const id = await insertProfile({ models: ["model-a"] });
    const resolver = createLlmResolver({ db: env.app, mode: "saas", encryptionKey: KEY, dnsResolver: publicDns, fetch: fakeFetch, ttlMs: 60_000 });
    const ports = portsFromResolver(resolver);
    const ok = await ports.llm.chat({ model: "model-a", messages: [{ role: "user", content: "ping" }] });
    expect(ok).toMatchObject({ content: "pong", model: "model-a", profileId: id });
    expect(ok.modelFallback).toBeUndefined();
    const c = calls.at(-1)!;
    expect(c.url).toBe("https://llm.example.com/v1/deployments/x/chat/completions?api-version=2024-06-01");
    expect(c.headers.get("api-key")).toBe("sekret-key-123");
    expect(c.headers.get("authorization")).toBeNull();
    expect(c.headers.get("x-org")).toBe("acme");
    const fb = await ports.llm.chat({ model: "gpt-4o-expensive", messages: [{ role: "user", content: "ping" }] });
    expect(fb).toMatchObject({ model: "model-default", modelFallback: { requested: "gpt-4o-expensive", used: "model-default" } });
    expect(calls.at(-1)!.body.model).toBe("model-default");
  });

  test("falls back to env when no profile exists; self-hosted ignores profiles", async () => {
    await env.owner`DELETE FROM llm_provider_profiles`;
    const mockEnv = { AI_PROVIDER: "mock" };
    const none = await createLlmResolver({ db: env.app, mode: "saas", env: mockEnv }).resolve();
    expect(none.profileId).toBeNull();
    await insertProfile();
    const sh = await createLlmResolver({ db: env.app, mode: "selfhosted", env: mockEnv, encryptionKey: KEY, dnsResolver: publicDns }).resolve();
    expect(sh.profileId).toBeNull();
  });

  test("SSRF: a profile pointing at a private address is refused at call time; undecryptable credentials fail closed", async () => {
    await insertProfile({ baseUrl: "https://llm.example.com/v1" });
    const privateDns = async () => ["10.0.0.5"];
    await expect(createLlmResolver({ db: env.app, mode: "saas", encryptionKey: KEY, dnsResolver: privateDns, fetch: fakeFetch }).resolve()).rejects.toThrow(/non-public/);
    await expect(createLlmResolver({ db: env.app, mode: "saas", encryptionKey: "fedcba9876543210".repeat(4), dnsResolver: publicDns, fetch: fakeFetch }).resolve()).rejects.toThrow(/decrypted/);
  });
});
