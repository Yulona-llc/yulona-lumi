import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "@yulona/db";
import { SKIP_MESSAGE, testUrls } from "@yulona/db/testing";
import { loadAgent } from "../src/agent-loader";
import { createMockPorts } from "../src/mock";
import { handleInboundMessage } from "../src/runtime";
import { runSandbox } from "../src/sandbox";
import { addCustomerMessage, seedAgent, seedConversation, seedTenant, setupAiDb, type TestEnv } from "./helpers";

const enabled = !!testUrls();
if (!enabled) console.warn(SKIP_MESSAGE);
const d = enabled ? describe : describe.skip;

let env: TestEnv;
beforeAll(async () => { if (enabled) env = (await setupAiDb())!; });
afterAll(async () => { if (enabled) await env.close(); });

const UNAVAILABLE = "This assistant is not available right now. A team member will reply.";
const handoffs = (conversationId: string) => env.owner<{ type: string; reason: string }[]>`SELECT type, reason FROM handoffs WHERE conversation_id = ${conversationId}`;

async function expectUnavailable(t: string, agentId: string | null, channel = "widget") {
  const ports = createMockPorts();
  const [c] = await env.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${t}) RETURNING id`;
  const [conv] = await env.owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, agent_id, channel) VALUES (${t}, ${c!.id}, ${agentId}, ${channel}) RETURNING id`;
  const messageId = await addCustomerMessage(env.owner, t, conv!.id, "what are your opening hours?");
  const r = await handleInboundMessage({ db: env.app, ports }, { tenantId: t, conversationId: conv!.id, messageId });
  expect(r.status).toBe("handoff");
  expect(ports.llm.calls).toHaveLength(0); // never reaches the model
  expect([...(await handoffs(conv!.id))]).toEqual([{ type: "system_failure", reason: "agent_unavailable" }]);
  const [m] = await env.owner<{ content: string }[]>`SELECT content FROM messages WHERE conversation_id = ${conv!.id} AND sender_type = 'ai'`;
  expect(m!.content).toContain(UNAVAILABLE);
  expect((await env.owner`SELECT count(*)::int AS n FROM ai_usage_events WHERE tenant_id = ${t}`)[0]!.n).toBe(0);
  // a second customer message while waiting for a person: silent, no second handoff / notification
  const m2 = await addCustomerMessage(env.owner, t, conv!.id, "hello? anyone?");
  const r2 = await handleInboundMessage({ db: env.app, ports }, { tenantId: t, conversationId: conv!.id, messageId: m2 });
  expect(r2).toMatchObject({ status: "skipped", reason: "ai_paused" });
  expect(await handoffs(conv!.id)).toHaveLength(1);
  expect(ports.llm.calls).toHaveLength(0);
  return conv!.id;
}

d("only published, non-archived agents answer", () => {
  test("loadAgent: draft-only, archived and missing agents are null; published loads its version; draft:true is for the sandbox", async () => {
    const t = await seedTenant(env.owner);
    const draft = await seedAgent(env.owner, t, { systemPrompt: "D" }, "draft");
    const live = await seedAgent(env.owner, t, { systemPrompt: "L" });
    const archived = await seedAgent(env.owner, t, { systemPrompt: "A" }, "archived");
    const load = (id: string | null, o = {}) => withTenant(env.app, t, (tx) => loadAgent(tx, t, id, o));
    expect(await load(draft)).toBeNull();
    expect(await load(archived)).toBeNull();
    expect(await load(null)).toBeNull(); // no "oldest agent" fallback
    expect(await load(crypto.randomUUID())).toBeNull();
    expect((await load(live))!.systemPrompt).toBe("L");
    expect((await load(draft, { draft: true }))!.systemPrompt).toBe("D");
    const ports = createMockPorts();
    const sb = await runSandbox({ db: env.app, ports }, { tenantId: t, agentId: draft, message: "hello" });
    expect(sb).not.toBeNull();
  });

  test("a never-published agent: unavailable handoff, zero LLM calls, one handoff per conversation", async () => {
    const t = await seedTenant(env.owner);
    await expectUnavailable(t, await seedAgent(env.owner, t, {}, "draft"));
  });

  test("a published agent that was archived stops answering; unarchiving brings it back", async () => {
    const t = await seedTenant(env.owner);
    const agent = await seedAgent(env.owner, t, {});
    await env.owner`UPDATE agents SET status = 'archived' WHERE id = ${agent}`;
    await expectUnavailable(t, agent);
    await env.owner`UPDATE agents SET status = 'published' WHERE id = ${agent}`; // what unarchive does for a published agent
    const ports = createMockPorts(() => ({ content: "Hello!" }));
    const c = await seedConversation(env.owner, t, agent, "hello");
    const r = await handleInboundMessage({ db: env.app, ports }, { tenantId: t, conversationId: c.conversationId, messageId: c.messageId });
    expect(r.status).toBe("replied");
    expect(ports.llm.calls.length).toBeGreaterThan(0);
  });

  test("a conversation with no agent does not fall back to the oldest agent", async () => {
    const t = await seedTenant(env.owner);
    await seedAgent(env.owner, t, {}); // live, but not assigned
    await expectUnavailable(t, null);
  });

  test("every inbound channel (widget, whatsapp, telegram) ends in the same unavailable handoff", async () => {
    const t = await seedTenant(env.owner);
    const agent = await seedAgent(env.owner, t, {}, "draft");
    for (const channel of ["widget", "whatsapp", "telegram"]) await expectUnavailable(t, agent, channel);
  });
});
