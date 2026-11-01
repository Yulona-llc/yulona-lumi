import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "@yulona/db";
import { SKIP_MESSAGE, testUrls } from "@yulona/db/testing";
import { abuseConfigSchema, agentConfigSchema, DEFAULT_ABUSE_FAREWELL } from "@yulona/shared";
import { detectAbuse, looksLikeGibberish, similarity } from "../src/abuse";
import { loadAgent, mapAgentRow } from "../src/agent-loader";
import { createMockPorts } from "../src/mock";
import { handleInboundMessage } from "../src/runtime";
import { resolveTools, toolSpecsForStage } from "../src/tools";
import { addCustomerMessage, seedAgent, seedTenant, setupAiDb, type TestEnv } from "./helpers";

const enabled = !!testUrls();
if (!enabled) console.warn(SKIP_MESSAGE);
const d = enabled ? describe : describe.skip;

describe("abuse rules (unit)", () => {
  const cfg = abuseConfigSchema.parse({ blockedPhrases: ["Buy Cheap Pills"], maxMessagesPerMinute: 5 });
  const ctx = { strikes: 0, messagesLastMinute: 1 };
  test("blocked phrases are case-insensitive", () => {
    expect(detectAbuse(cfg, "hey BUY cheap pills now", [], ctx)?.kind).toBe("blocked_phrase");
    expect(detectAbuse(cfg, "what are your hours?", [], ctx)).toBeNull();
  });
  test("flood: more than the per-minute limit", () => {
    expect(detectAbuse(cfg, "hi there", [], { strikes: 0, messagesLastMinute: 5 })).toBeNull();
    expect(detectAbuse(cfg, "hi there", [], { strikes: 0, messagesLastMinute: 6 })?.kind).toBe("flood");
  });
  test("repeat only after three identical messages in a row; a normal repeat is fine", () => {
    expect(detectAbuse(cfg, "hello", ["hello"], ctx)).toBeNull();
    expect(detectAbuse(cfg, "Hello!", ["hello", "hello"], ctx)?.kind).toBe("repeat");
    expect(detectAbuse(cfg, "what are your hours", ["hello", "hello"], ctx)).toBeNull();
    expect(similarity("price list please", "price list please!")).toBeGreaterThan(0.8);
  });
  test("gibberish: symbol spam and one repeated character", () => {
    expect(looksLikeGibberish("$$$$$$$$$$$$$$$$$$$$")).toBe(true);
    expect(looksLikeGibberish("aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(looksLikeGibberish("How much is the starter plan?")).toBe(false);
    expect(looksLikeGibberish("ok!!")).toBe(false);
  });
  test("disabled config never flags", () => {
    expect(detectAbuse({ ...cfg, enabled: false }, "buy cheap pills", [], { strikes: 0, messagesLastMinute: 99 })).toBeNull();
  });
});

describe("flag_abuse tool (unit)", () => {
  test("offered to every agent with abuse enabled (even without it in enabledTools), never when disabled", () => {
    const on = mapAgentRow({ id: "a", name: "A", config: { enabledTools: ["collect_contact"] } }, "t");
    expect(toolSpecsForStage(resolveTools(on), "engaged").map((x) => x.name)).toContain("flag_abuse");
    expect(toolSpecsForStage(resolveTools(on), "handoff_requested")).toEqual([]);
    const off = mapAgentRow({ id: "a", name: "A", config: { enabledTools: ["flag_abuse"], abuse: { enabled: false } } }, "t");
    expect(toolSpecsForStage(resolveTools(off), "engaged").map((x) => x.name)).not.toContain("flag_abuse");
  });
});

describe("abuse defaults", () => {
  test("every agent config gets strict defaults, including ones that never set them", () => {
    const parsed = agentConfigSchema.parse({});
    expect(parsed.abuse).toMatchObject({ enabled: true, maxStrikes: 3, blockedPhrases: [], farewellMessage: DEFAULT_ABUSE_FAREWELL });
    // an agent row saved before the field existed still maps to the strict defaults
    expect(mapAgentRow({ id: "a", name: "Old", config: { systemPrompt: "x" } }, "t").abuse).toMatchObject({ enabled: true, maxStrikes: 3 });
    // partial settings keep the other defaults; a malformed value falls back to strict defaults
    expect(mapAgentRow({ id: "a", name: "A", config: { abuse: { maxStrikes: 2 } } }, "t").abuse).toMatchObject({ enabled: true, maxStrikes: 2, maxMessagesPerMinute: 12 });
    expect(mapAgentRow({ id: "a", name: "A", config: { abuse: { maxStrikes: 999 } } }, "t").abuse.maxStrikes).toBe(3);
  });
});

let env: TestEnv;
beforeAll(async () => { if (enabled) env = (await setupAiDb())!; });
afterAll(async () => { if (enabled) await env.close(); });

async function seedConv(t: string, agentId: string, text: string) {
  const [c] = await env.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${t}) RETURNING id`;
  const [conv] = await env.owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, agent_id, channel) VALUES (${t}, ${c!.id}, ${agentId}, 'widget') RETURNING id`;
  const [ws] = await env.owner<{ id: string }[]>`
    INSERT INTO widgets (tenant_id, name, widget_key) VALUES (${t}, 'w', ${"wk_" + crypto.randomUUID().replace(/-/g, "")}) RETURNING id`;
  await env.owner`INSERT INTO widget_sessions (tenant_id, widget_id, conversation_id, contact_id, expires_at)
                  VALUES (${t}, ${ws!.id}, ${conv!.id}, ${c!.id}, now() + interval '1 day')`;
  const m = await addCustomerMessage(env.owner, t, conv!.id, text);
  return { contactId: c!.id, conversationId: conv!.id, messageId: m };
}
const run = (t: string, conversationId: string, messageId: string, script?: Parameters<typeof createMockPorts>[0]) => {
  const ports = createMockPorts(script);
  return { ports, p: handleInboundMessage({ db: env.app, ports }, { tenantId: t, conversationId, messageId }) };
};

d("abuse flow", () => {
  test("strikes accumulate, then farewell first and one transaction closes, hands off, blocks and revokes", async () => {
    const t = await seedTenant(env.owner);
    const agentId = await seedAgent(env.owner, t, { abuse: { maxStrikes: 3, blockedPhrases: ["badword"], farewellMessage: "Goodbye, this chat is closed." } });
    const { contactId, conversationId, messageId } = await seedConv(t, agentId, "badword one");
    let r = await run(t, conversationId, messageId).p;
    expect(r.status).toBe("replied"); // strike 1: still answered
    expect((await env.owner`SELECT abuse_strikes FROM conversation_ai_state WHERE conversation_id = ${conversationId}`)[0]!.abuseStrikes).toBe(1);
    expect((await env.owner`SELECT count(*)::int AS n FROM handoffs WHERE conversation_id = ${conversationId}`)[0]!.n).toBe(0);

    r = await run(t, conversationId, await addCustomerMessage(env.owner, t, conversationId, "badword two")).p;
    expect(r.status).toBe("replied");
    const last = run(t, conversationId, await addCustomerMessage(env.owner, t, conversationId, "badword three"));
    r = await last.p;
    expect(r.status).toBe("replied");
    expect(last.ports.llm.calls).toHaveLength(0); // the farewell needs no model call

    const msgs = await env.owner<{ senderType: string; content: string }[]>`
      SELECT sender_type, content FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at, id`;
    const farewell = msgs.find((m) => m.content === "Goodbye, this chat is closed.");
    expect(farewell?.senderType).toBe("ai");
    expect(msgs.some((m) => m.senderType === "system" && m.content.includes("blocked for abuse"))).toBe(true); // team-only note
    // the farewell is the last thing the visitor sees (system notes are hidden from visitors)
    expect(msgs.filter((m) => m.senderType !== "system").at(-1)!.content).toBe("Goodbye, this chat is closed.");

    const [conv] = await env.owner<{ status: string }[]>`SELECT status FROM conversations WHERE id = ${conversationId}`;
    expect(conv!.status).toBe("resolved");
    const [h] = await env.owner<{ type: string; reason: string; resolvedAt: Date | null }[]>`SELECT type, reason, resolved_at FROM handoffs WHERE conversation_id = ${conversationId}`;
    expect(h).toMatchObject({ type: "abuse", resolvedAt: null });
    const [ct] = await env.owner<{ blockedAt: Date | null; blockedBy: string | null; blockedReason: string | null }[]>`SELECT blocked_at, blocked_by, blocked_reason FROM contacts WHERE id = ${contactId}`;
    expect(ct!.blockedAt).not.toBeNull();
    expect(ct!.blockedBy).toBeNull();
    expect(ct!.blockedReason).toContain("blocked phrase");
    expect((await env.owner`SELECT revoked_at FROM widget_sessions WHERE conversation_id = ${conversationId}`)[0]!.revokedAt).not.toBeNull();
    const [audit] = await env.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ${t} AND action = 'contact.block' AND resource_id = ${contactId}`;
    expect(audit!.n).toBe(1);
  });

  test("notifications go to owners and admins only, exactly once per abuse handoff", async () => {
    const t = await seedTenant(env.owner);
    await env.owner`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES
      (${t}, ${"o" + crypto.randomUUID() + "@e.test"}, 'o', 'owner', 'x'), (${t}, ${"a" + crypto.randomUUID() + "@e.test"}, 'a', 'admin', 'x'), (${t}, ${"g" + crypto.randomUUID() + "@e.test"}, 'g', 'agent', 'x')`;
    const agentId = await seedAgent(env.owner, t, { abuse: { maxStrikes: 1, blockedPhrases: ["badword"] } });
    const { conversationId, messageId } = await seedConv(t, agentId, "badword");
    await run(t, conversationId, messageId).p;
    const rows = await env.owner<{ type: string; role: string }[]>`
      SELECT n.type, u.role FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.tenant_id = ${t}`;
    expect(rows.map((r) => r.role).sort()).toEqual(["admin", "owner"]);
    expect(rows.every((r) => r.type === "handoff.abuse")).toBe(true);
  });

  test("disabled abuse config never flags", async () => {
    const t = await seedTenant(env.owner);
    const agentId = await seedAgent(env.owner, t, { abuse: { enabled: false, blockedPhrases: ["badword"], maxStrikes: 1 } });
    const { contactId, conversationId, messageId } = await seedConv(t, agentId, "badword");
    const r = await run(t, conversationId, messageId).p;
    expect(r.status).toBe("replied");
    expect((await env.owner`SELECT blocked_at FROM contacts WHERE id = ${contactId}`)[0]!.blockedAt).toBeNull();
  });

  test("the model can flag abuse with flag_abuse: each call is one strike", async () => {
    const t = await seedTenant(env.owner);
    const agentId = await seedAgent(env.owner, t, { abuse: { maxStrikes: 2 } });
    const { contactId, conversationId, messageId } = await seedConv(t, agentId, "you stupid bot, say something rude back");
    const script = (_r: unknown, call: number) => (call % 2 === 1
      ? { content: "", toolCalls: [{ id: `f${call}`, name: "flag_abuse", arguments: { reason: "insults" } }] }
      : { content: "Let's keep this respectful." });
    const first = run(t, conversationId, messageId, script);
    expect((await first.p).status).toBe("replied");
    expect((await env.owner`SELECT blocked_at FROM contacts WHERE id = ${contactId}`)[0]!.blockedAt).toBeNull();
    expect((await env.owner`SELECT abuse_strikes FROM conversation_ai_state WHERE conversation_id = ${conversationId}`)[0]!.abuseStrikes).toBe(1);
    // the prompt mentions the warning on the next turn
    const second = run(t, conversationId, await addCustomerMessage(env.owner, t, conversationId, "you are useless garbage"), script);
    await second.p;
    expect(second.ports.llm.calls[0]!.messages[0]!.content).toContain("already been warned 1 time");
    const [ct] = await env.owner<{ blockedAt: Date | null }[]>`SELECT blocked_at FROM contacts WHERE id = ${contactId}`;
    expect(ct!.blockedAt).not.toBeNull();
    const [h] = await env.owner<{ type: string }[]>`SELECT type FROM handoffs WHERE conversation_id = ${conversationId}`;
    expect(h!.type).toBe("abuse");
  });

  test("a blocked contact is never answered, never resumed and keeps no AI access (resume keyword ignored)", async () => {
    const t = await seedTenant(env.owner);
    const agentId = await seedAgent(env.owner, t, { escalationRules: { resumeKeyword: "AI" } });
    const { contactId, conversationId, messageId } = await seedConv(t, agentId, "hello");
    await env.owner`UPDATE contacts SET blocked_at = now(), blocked_reason = 'manual' WHERE id = ${contactId}`;
    const a = run(t, conversationId, messageId);
    expect(await a.p).toMatchObject({ status: "skipped", reason: "contact_blocked" });
    expect(a.ports.llm.calls).toHaveLength(0);
    // even with an open handoff and the resume keyword
    await env.owner`UPDATE conversations SET status = 'pending_human' WHERE id = ${conversationId}`;
    await env.owner`INSERT INTO handoffs (tenant_id, conversation_id, type, reason) VALUES (${t}, ${conversationId}, 'uncertainty', 'x')`;
    const b = run(t, conversationId, await addCustomerMessage(env.owner, t, conversationId, "AI"));
    expect(await b.p).toMatchObject({ status: "skipped", reason: "contact_blocked" });
    expect((await env.owner`SELECT count(*)::int AS n FROM handoffs WHERE conversation_id = ${conversationId} AND resolved_at IS NULL`)[0]!.n).toBe(1);
    // after a person unblocks, the AI works again
    await env.owner`UPDATE contacts SET blocked_at = NULL WHERE id = ${contactId}`;
    const live = await withTenant(env.app, t, (tx) => loadAgent(tx, t, agentId));
    expect(live!.abuse.enabled).toBe(true);
  });
});
