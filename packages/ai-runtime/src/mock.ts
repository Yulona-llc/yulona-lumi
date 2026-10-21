import type { AiPorts, ChatMessage, LlmPort, LlmRequest, LlmResult } from "./ports";

export type MockLlmScript = (req: LlmRequest, call: number) => Partial<LlmResult> | Promise<Partial<LlmResult>>;

/**
 * Deterministic LLM. Without a script it answers by quoting the first knowledge excerpt found in the
 * system prompt (so tests can assert grounding) and never calls tools.
 */
export function createMockLlm(script?: MockLlmScript): LlmPort & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const r = script ? await script(req, calls.length) : defaultReply(req.messages);
      const text = r.content === undefined ? null : r.content;
      return {
        content: text,
        toolCalls: r.toolCalls ?? [],
        ...(r.model ? { model: r.model } : {}),
        ...(r.profileId !== undefined ? { profileId: r.profileId } : {}),
        ...(r.modelFallback ? { modelFallback: r.modelFallback } : {}),
        usage: r.usage ?? { promptTokens: Math.ceil(req.messages.reduce((a, m) => a + m.content.length, 0) / 4), completionTokens: Math.ceil((text ?? "").length / 4) },
      };
    },
  };
}

/** Words too common to count as "the question is about this text" (mimics a model judging relevance). */
const COMMON = new Set(["what", "when", "where", "which", "your", "you", "are", "the", "and", "for", "how", "does", "can", "with", "this", "that", "have", "about", "tell", "please", "much", "many", "from", "there", "their", "will", "would", "could", "should"]);
const words = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !COMMON.has(w)).map((w) => w.replace(/(ing|ed|es|s|e)$/u, ""));

/** Quotes the knowledge block that shares the most words with the customer's message, else declines like a grounded model. */
function defaultReply(messages: ChatMessage[]): Partial<LlmResult> {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const asked = new Set(words(/<user_message>\n?([\s\S]*?)\n?<\/user_message>/.exec(last)?.[1] ?? last));
  let best = "";
  let bestScore = 0;
  for (const m of sys.matchAll(/<knowledge id=[^>]*>\n?([\s\S]*?)<\/knowledge>/g)) {
    const text = m[1]!.trim();
    const score = words(text).filter((w) => asked.has(w)).length;
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best
    ? { content: `Based on our information: ${best.split("\n")[0]!.slice(0, 300)}` }
    : { content: "[[NO_ANSWER]] Could you tell me a bit more about what you need?" };
}

export function createMockPorts(script?: MockLlmScript): AiPorts & { llm: ReturnType<typeof createMockLlm> } {
  return { llm: createMockLlm(script) };
}
