/**
 * Provider ports. ai-runtime depends only on these structural interfaces; `@yulona/providers`
 * (owned by `platform`) implementations are adapted to them in `providers-adapter.ts`.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant messages that requested tools */
  toolCalls?: ToolCall[];
  /** tool result messages */
  toolCallId?: string;
  name?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object */
  parameters: Record<string, unknown>;
}
export interface LlmRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** forwarded as `reasoning_effort` when the provider supports it (AI_REASONING_EFFORT) */
  reasoningEffort?: string;
  signal?: AbortSignal;
}
export interface LlmResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  /** model that served the call (provider-reported when available) */
  model?: string;
  /** provider profile id when resolved from the platform profiles (null = env provider) */
  profileId?: string | null;
  /** the requested model was not enabled; `used` answered instead */
  modelFallback?: { requested: string; used: string };
}
export interface LlmPort {
  chat(req: LlmRequest): Promise<LlmResult>;
}
export interface AiPorts {
  llm: LlmPort;
}
