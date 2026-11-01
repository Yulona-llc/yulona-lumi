import { describe, expect, test } from "bun:test";
import { mapAgentRow } from "../src/agent-loader";
import { turnLimits } from "../src/limits";
import { createMockPorts } from "../src/mock";
import { runTurn } from "../src/turn";
import type { AgentConfig, TurnMessage } from "../src/types";
import { fakeKnowledge } from "./helpers";

const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({ ...mapAgentRow({ id: "a", name: "Bot" }, "t"), ...over });
const cap = { text: true, richCards: true, forms: true, fileUpload: true, typingIndicator: true, interactiveButtons: true, messageWindow: null };

/** Four skills of ~6k chars each: far above the inline limit, so the agent works through tools. */
const skills = () => ["pricing", "shipping", "returns", "warranty"].map((skill, i) => ({
  skill, title: `${skill} details`, content: `${skill} policy number ${i}. ${"The detailed clause text goes here. ".repeat(65)} Final answer for ${skill}: the code is ${skill.toUpperCase()}-42.`,
}));
type Call = { tools?: { name: string }[]; messages: { role: string; content: string }[] };
const callsOf = (p: unknown) => (p as { llm: { calls: Call[] } }).llm.calls;

describe("turn cost controls", () => {
  test("a model that keeps asking for tools is stopped after 2 tool rounds with a tool-free final answer, well under the token budget", async () => {
    const kb = fakeKnowledge(skills());
    const ports = createMockPorts((req, n) => {
      if (req.tools?.length) return n === 1
        ? { toolCalls: [{ id: "c1", name: "search_skills", arguments: { query: "warranty code" } }] }
        : { toolCalls: [{ id: `c${n}`, name: "read_skill", arguments: { skill: "warranty", section: 3 } }] };
      return { content: "The warranty code is WARRANTY-42." };
    });
    const out = await runTurn(ports, { agent: agent(), capability: cap, stage: "engaged", lead: {}, history: [], userText: "What is the warranty code for my order?", knowledge: kb });
    const calls = callsOf(ports);
    expect(calls).toHaveLength(3); // 2 tool rounds + the forced final
    expect(calls[0]!.tools?.map((t) => t.name)).toContain("search_skills");
    expect(calls[2]!.tools).toBeUndefined();
    expect(out.text).toContain("WARRANTY-42");
    expect(out.usage.promptTokens).toBeLessThan(12_000) // worst case: two full tool rounds + final; typical turns are one call;
    expect(out.usage.completionTokens).toBeLessThan(1_000);
  });

  test("the token budget ends the tool phase early", async () => {
    const prev = process.env.AI_TURN_TOKEN_BUDGET;
    process.env.AI_TURN_TOKEN_BUDGET = "1000"; // minimum
    try {
      const ports = createMockPorts((req) => (req.tools?.length
        ? { toolCalls: [{ id: "c", name: "read_skill", arguments: { skill: "pricing", section: 0 } }], usage: { promptTokens: 2000, completionTokens: 50 } }
        : { content: "Done." }));
      await runTurn(ports, { agent: agent(), capability: cap, stage: "engaged", lead: {}, history: [], userText: "What is the pricing code?", knowledge: fakeKnowledge(skills()) });
      const calls = callsOf(ports);
      expect(calls).toHaveLength(2); // first call blew the budget -> next call is the tool-free final
      expect(calls[1]!.tools).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AI_TURN_TOKEN_BUDGET; else process.env.AI_TURN_TOKEN_BUDGET = prev;
    }
  });

  test("earlier tool results are shortened once consumed; the latest one is kept whole", async () => {
    const ports = createMockPorts((req, n) => (req.tools?.length
      ? { toolCalls: [{ id: `c${n}`, name: "read_skill", arguments: { skill: n === 1 ? "pricing" : "returns", section: n === 1 ? 0 : 2 } }] }
      : { content: "ok" }));
    await runTurn(ports, { agent: agent(), capability: cap, stage: "engaged", lead: {}, history: [], userText: "pricing and returns info please", knowledge: fakeKnowledge(skills()) });
    const last = callsOf(ports)[2]!.messages.filter((m) => m.role === "tool");
    expect(last).toHaveLength(2);
    expect(last[0]!.content).toContain("[earlier result");
    expect(last[0]!.content.length).toBeLessThan(500);
    expect(last[1]!.content).not.toContain("[earlier result");
    expect(last[1]!.content.length).toBeGreaterThan(1500);
  });

  test("read_skill output is capped (default 3000 chars of section text) and history is 6 messages of at most ~600 chars", async () => {
    const ports = createMockPorts((req, n) => (n === 1 && req.tools?.length ? { toolCalls: [{ id: "c", name: "read_skill", arguments: { skill: "pricing", section: 0 } }] } : { content: "ok" }));
    const history: TurnMessage[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i} ` + "x".repeat(2000) }));
    await runTurn(ports, { agent: agent(), capability: cap, stage: "engaged", lead: {}, history, userText: "what does pricing cost", knowledge: fakeKnowledge(skills()) });
    const second = callsOf(ports)[1]!.messages;
    const tool = second.find((m) => m.role === "tool")!;
    expect(tool.content.length).toBeLessThan(3000 + 200);
    const hist = second.filter((m) => m.role !== "system" && m.role !== "tool").slice(0, -1).filter((m) => /m\d/.test(m.content));
    expect(hist).toHaveLength(6);
    for (const h of hist) expect(h.content.length).toBeLessThan(700);
    expect(hist[0]!.content).toContain("m4");
  });

  test("a small knowledge base is inlined: one call, no tools", async () => {
    const ports = createMockPorts(() => ({ content: "Nine to five." }));
    await runTurn(ports, { agent: agent(), capability: cap, stage: "engaged", lead: {}, history: [], userText: "what are your hours", knowledge: fakeKnowledge([{ content: "We open nine to five." }]) });
    expect(callsOf(ports)).toHaveLength(1);
    expect(callsOf(ports)[0]!.tools?.map((t) => t.name) ?? []).not.toContain("read_skill");
  });

  test("a timed-out first attempt that was billed is counted (estimate) in usage", async () => {
    let n = 0;
    const base = createMockPorts(() => ({ content: "Nine to five.", usage: { promptTokens: 100, completionTokens: 10 } }));
    const ports = { llm: { chat: async (r: Parameters<typeof base.llm.chat>[0]) => { if (n++ === 0) throw new Error("timeout"); return base.llm.chat(r); } } };
    const out = await runTurn(ports, { agent: agent(), capability: cap, stage: "engaged", lead: {}, history: [], userText: "what are your hours", knowledge: fakeKnowledge([{ content: "We open nine to five." }]) });
    expect(out.usage.promptTokens).toBeGreaterThan(100);
  });

  test("limits are env-tunable and clamped", () => {
    expect(turnLimits({}).maxToolRounds).toBe(2);
    expect(turnLimits({ AI_MAX_TOOL_ROUNDS: "4", AI_HISTORY_MESSAGES: "12", AI_READ_SKILL_MAX_CHARS: "8000", AI_INLINE_ALL_CHARS: "9000" })).toMatchObject({ maxToolRounds: 4, historyMessages: 12, readCapChars: 8000, inlineAllChars: 9000 });
    expect(turnLimits({ AI_MAX_TOOL_ROUNDS: "999", AI_TURN_TOKEN_BUDGET: "abc" })).toMatchObject({ maxToolRounds: 6, turnTokenBudget: 12_000 });
    expect(turnLimits({ AI_REASONING_EFFORT: "Low" }).reasoningEffort).toBe("low");
    expect(turnLimits({ AI_REASONING_EFFORT: "bogus" }).reasoningEffort).toBeUndefined();
  });
});
