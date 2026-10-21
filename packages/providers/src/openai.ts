import type {
  LlmProvider, LlmRequest, LlmResponse, ToolCall,
} from "./types";
import { ProviderError } from "./types";

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  /** header carrying the key (default `Authorization`) */
  authHeader?: string;
  /** `bearer` => `<header>: Bearer <key>`, `raw` => `<header>: <key>` (e.g. `api-key`), `none` => no auth header */
  authScheme?: "bearer" | "raw" | "none";
  extraHeaders?: Record<string, string>;
  /** appended to every request URL (e.g. Azure `api-version`) */
  queryParams?: Record<string, string>;
  /** default `/chat/completions` */
  chatPath?: string;
}

/** Build the request URL + headers for an OpenAI-compatible endpoint (exported for tests). */
export function buildRequest(o: OpenAiOptions, path: string): { url: string; headers: Record<string, string> } {
  const base = `${(o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}${path}`;
  const qs = new URLSearchParams(o.queryParams ?? {}).toString();
  const url = qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(o.extraHeaders ?? {})) headers[k.toLowerCase()] = v;
  const scheme = o.authScheme ?? "bearer";
  if (scheme !== "none" && o.apiKey) headers[(o.authHeader ?? "authorization").toLowerCase()] = scheme === "bearer" ? `Bearer ${o.apiKey}` : o.apiKey;
  return { url, headers };
}

async function post(o: OpenAiOptions, path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const f = o.fetch ?? fetch;
  const { url, headers } = buildRequest(o, path);
  const retries = o.maxRetries ?? 2;
  let lastErr: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000);
    try {
      const res = await f(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 300); // never includes our key
      lastErr = new ProviderError(`openai ${res.status}: ${text}`, "openai", res.status === 429 || res.status >= 500, res.status);
    } catch (e) {
      if (signal?.aborted) throw new ProviderError("aborted", "openai", false);
      lastErr = new ProviderError(`openai request failed: ${(e as Error).message}`, "openai", true);
    }
    if (!lastErr.retryable || attempt === retries) break;
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  throw lastErr!;
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name = "openai";
  constructor(private readonly o: OpenAiOptions) {}
  async chat(req: LlmRequest): Promise<LlmResponse> {
    const model = req.model ?? this.o.model ?? "gpt-4o-mini";
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => {
        if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant", content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
          };
        }
        return { role: m.role, content: m.content };
      }),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    const j = await post(this.o, this.o.chatPath ?? "/chat/completions", body, req.signal);
    const choice = j.choices?.[0];
    if (!choice) throw new ProviderError("openai: empty response", "openai", false);
    const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((c: any) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch { /* model produced bad JSON: empty args, validated by the tool executor */ }
      return { id: String(c.id), name: String(c.function?.name), arguments: args };
    });
    const fr = choice.finish_reason;
    return {
      content: choice.message?.content ?? "",
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : fr === "stop" ? "stop" : fr === "length" ? "length" : "other",
      usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 },
      model: j.model ?? model,
    };
  }
}
