import type { LlmProvider } from "@yulona/providers";
import type { AiPorts } from "./ports";

/** Adapt `@yulona/providers` implementations to the runtime's ports. */
export function portsFromProviders(p: { llm: LlmProvider }): AiPorts {
  return {
    llm: {
      async chat(req) {
        const r = await p.llm.chat({
          messages: req.messages, tools: req.tools, model: req.model, temperature: req.temperature, maxTokens: req.maxTokens, reasoningEffort: req.reasoningEffort, signal: req.signal,
        });
        return { content: r.content || null, toolCalls: r.toolCalls, usage: { promptTokens: r.usage.inputTokens, completionTokens: r.usage.outputTokens }, model: r.model };
      },
    },
  };
}
