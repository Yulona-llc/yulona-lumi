import { describe, expect, test } from "bun:test";
import {
  MemoryStorageProvider, MockCalendarProvider, MockLlmProvider, MockVirusScanner,
  OpenAiLlmProvider, ProviderError, createMockProviders, createProvidersFromEnv,
} from "../src";

describe("mock providers", () => {
  test("llm: echo, tool call, failure, override", async () => {
    const l = new MockLlmProvider();
    expect((await l.chat({ messages: [{ role: "user", content: "hi" }] })).content).toBe("[mock] hi");
    const t = await l.chat({ messages: [{ role: "user", content: '/tool qualify_lead {"budget":5}' }] });
    expect(t.toolCalls[0]).toMatchObject({ name: "qualify_lead", arguments: { budget: 5 } });
    expect(t.finishReason).toBe("tool_calls");
    await expect(l.chat({ messages: [{ role: "user", content: "/fail" }] })).rejects.toThrow();
    expect(l.calls).toHaveLength(3);
    const o = new MockLlmProvider(() => ({ content: "fixed" }));
    expect((await o.chat({ messages: [] })).content).toBe("fixed");
  });
  test("storage, calendar, scanner", async () => {
    const s = new MemoryStorageProvider();
    await s.put("a/b.txt", "hello", { contentType: "text/plain" });
    expect(new TextDecoder().decode((await s.get("a/b.txt"))!.body)).toBe("hello");
    await s.delete("a/b.txt");
    expect(await s.exists("a/b.txt")).toBe(false);
    const c = new MockCalendarProvider();
    const from = "2030-01-07T00:00:00Z"; // Monday
    const slots = await c.availability({ from, to: "2030-01-07T23:59:00Z", durationMinutes: 30 });
    expect(slots).toHaveLength(16);
    await c.createEvent({ title: "x", start: slots[0]!.start, end: slots[0]!.end });
    expect(await c.availability({ from, to: "2030-01-07T23:59:00Z", durationMinutes: 30 })).toHaveLength(15);
    expect((await new MockVirusScanner().scan(new TextEncoder().encode("X5O!EICAR-STANDARD-ANTIVIRUS-TEST-FILE!"))).clean).toBe(false);
  });
});

describe("openai provider (fake fetch)", () => {
  const fakeFetch = (responses: Response[], seen: { url: string; init: RequestInit }[] = []) =>
    (async (url: string, init: RequestInit) => { seen.push({ url, init }); return responses.shift()!; }) as unknown as typeof fetch;
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  test("chat maps request/response incl. tool calls; key only in header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new OpenAiLlmProvider({ apiKey: "sk-secret", fetch: fakeFetch([ok({
      model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "qualify_lead", arguments: '{"a":1}' } }] } }],
    })], seen) });
    const r = await p.chat({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: [{ name: "qualify_lead", description: "d", parameters: { type: "object" } }], temperature: 0 });
    expect(r.toolCalls).toEqual([{ id: "c1", name: "qualify_lead", arguments: { a: 1 } }]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-secret");
    expect(String(seen[0]!.init.body)).not.toContain("sk-secret");
    expect(JSON.parse(String(seen[0]!.init.body)).tools[0].function.name).toBe("qualify_lead");
  });
  test("retries 429/5xx, not 4xx; errors never leak key", async () => {
    const p = new OpenAiLlmProvider({ apiKey: "sk-secret", fetch: fakeFetch([new Response("slow down", { status: 429 }), ok({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] })]) });
    expect((await p.chat({ messages: [{ role: "user", content: "x" }] })).content).toBe("hi");
    const bad = new OpenAiLlmProvider({ apiKey: "sk-secret", fetch: fakeFetch([new Response("nope", { status: 401 })]) });
    const err = await bad.chat({ messages: [] }).catch((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(String((err as ProviderError).message)).not.toContain("sk-secret");
  });
});

describe("factory", () => {
  test("defaults to mock without a key; openai requires key; unknown rejected", () => {
    const p = createProvidersFromEnv({});
    expect(p.llm.name).toBe("mock");
    expect(p.email.name).toBe("console");
    expect(createProvidersFromEnv({ AI_API_KEY: "k" }).llm.name).toBe("openai");
    expect(() => createProvidersFromEnv({ AI_PROVIDER: "openai" })).toThrow();
    expect(() => createProvidersFromEnv({ AI_PROVIDER: "foo" })).toThrow();
    expect(createProvidersFromEnv({ SMTP_HOST: "h" }).email.name).toBe("smtp");
    expect("embeddings" in p).toBe(false); // knowledge is read as skills, not embedded
    expect(createMockProviders().storage.name).toBe("memory");
  });
});

describe("deepseek provider wiring", () => {
  test("deepseek needs a key, defaults to deepseek-chat and the DeepSeek base URL", async () => {
    const { createProvidersFromEnv } = await import("../src");
    expect(() => createProvidersFromEnv({ AI_PROVIDER: "deepseek" })).toThrow(/AI_API_KEY/);
    const p = createProvidersFromEnv({ AI_PROVIDER: "deepseek", AI_API_KEY: "k" });
    expect(p.llm.name).toBe("openai");
  });
  test("unknown provider still rejected", async () => {
    const { createProvidersFromEnv } = await import("../src");
    expect(() => createProvidersFromEnv({ AI_PROVIDER: "nope" })).toThrow(/Unknown AI_PROVIDER/);
  });
});
