import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAiLlmProvider, buildRequest, createProvidersFromEnv, openAiCompatOptionsFromEnv } from "../src";

// A real HTTP server records what the provider sends, so header/query/path behaviour is tested over the wire.
const seen: { path: string; search: string; headers: Headers; body: any }[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.json();
      seen.push({ path: u.pathname, search: u.search, headers: req.headers, body });
      return Response.json({ model: "served-model", choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

const ask = (o: ConstructorParameters<typeof OpenAiLlmProvider>[0]) => new OpenAiLlmProvider({ baseUrl: base, maxRetries: 0, ...o }).chat({ messages: [{ role: "user", content: "ping" }] });
const last = () => seen.at(-1)!;

describe("OpenAI-compatible provider options", () => {
  test("default: Authorization: Bearer <key> on /chat/completions, model reported by the server is returned", async () => {
    const r = await ask({ apiKey: "sk-test" });
    expect(last().path).toBe("/chat/completions");
    expect(last().headers.get("authorization")).toBe("Bearer sk-test");
    expect(r).toMatchObject({ content: "pong", model: "served-model", usage: { inputTokens: 7, outputTokens: 3 } });
  });

  test("raw scheme in a custom header (Azure api-key), no Authorization header", async () => {
    await ask({ apiKey: "azure-key", authHeader: "api-key", authScheme: "raw" });
    expect(last().headers.get("api-key")).toBe("azure-key");
    expect(last().headers.get("authorization")).toBeNull();
  });

  test("none scheme sends no credentials at all", async () => {
    await ask({ apiKey: "ignored", authScheme: "none" });
    expect(last().headers.get("authorization")).toBeNull();
    expect(last().headers.get("api-key")).toBeNull();
  });

  test("extra headers (case-insensitive) and query params (Azure api-version) and a custom chat path", async () => {
    await ask({ apiKey: "k", extraHeaders: { "X-Org": "acme", "x-trace": "1" }, queryParams: { "api-version": "2024-06-01", deployment: "d 1" }, chatPath: "/openai/deployments/gpt/chat/completions" });
    expect(last().path).toBe("/openai/deployments/gpt/chat/completions");
    expect(last().search).toBe("?api-version=2024-06-01&deployment=d+1");
    expect(last().headers.get("x-org")).toBe("acme");
    expect(last().headers.get("x-trace")).toBe("1");
    expect(last().headers.get("authorization")).toBe("Bearer k");
  });

  test("extra headers cannot smuggle a second credential header past the configured one", () => {
    const { headers } = buildRequest({ apiKey: "real", extraHeaders: { Authorization: "Bearer other" } }, "/x");
    expect(headers.authorization).toBe("Bearer real");
  });

  test("provider errors never include the key", async () => {
    const bad = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 401 }) });
    try {
      await new OpenAiLlmProvider({ apiKey: "sk-super-secret", baseUrl: `http://localhost:${bad.port}`, maxRetries: 0 }).chat({ messages: [{ role: "user", content: "x" }] });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as Error).message).toContain("401");
      expect((e as Error).message).not.toContain("sk-super-secret");
    } finally { bad.stop(true); }
  });
});

describe("env configuration", () => {
  test("AI_AUTH_HEADER / AI_AUTH_SCHEME / AI_EXTRA_HEADERS / AI_QUERY / AI_CHAT_PATH reach the provider", async () => {
    const env = {
      AI_PROVIDER: "openai", AI_API_KEY: "env-key", AI_BASE_URL: base, AI_AUTH_HEADER: "api-key", AI_AUTH_SCHEME: "raw",
      AI_EXTRA_HEADERS: '{"x-env":"yes"}', AI_QUERY: '{"api-version":"v9"}', AI_CHAT_PATH: "/v1/chat",
    };
    const p = createProvidersFromEnv(env);
    await p.llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(last().path).toBe("/v1/chat");
    expect(last().search).toBe("?api-version=v9");
    expect(last().headers.get("api-key")).toBe("env-key");
    expect(last().headers.get("x-env")).toBe("yes");
  });

  test("no key needed with AI_AUTH_SCHEME=none; malformed JSON/scheme is rejected at startup", () => {
    expect(() => createProvidersFromEnv({ AI_PROVIDER: "openai", AI_AUTH_SCHEME: "none", AI_BASE_URL: base })).not.toThrow();
    expect(() => createProvidersFromEnv({ AI_PROVIDER: "openai", AI_API_KEY: "k", AI_EXTRA_HEADERS: "{nope" })).toThrow(/AI_EXTRA_HEADERS/);
    expect(() => openAiCompatOptionsFromEnv({ AI_QUERY: '{"a":1}' })).toThrow(/AI_QUERY/);
    expect(() => openAiCompatOptionsFromEnv({ AI_AUTH_SCHEME: "digest" })).toThrow(/AI_AUTH_SCHEME/);
  });
});
