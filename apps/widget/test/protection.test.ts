import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi, type Api } from "../src/api";
import { Chat } from "../src/chat";

const noTransport = () => ({ stop() {} });
const protectedConfig = {
  title: "T", primaryColor: "#4f46e5", position: "right" as const, theme: "light" as const,
  protection: { honeypot: true, turnstile: { siteKey: "0xKEY", theme: "auto" as const, size: "normal" as const, appearance: "always" as const } },
};
function fakeApi(over: Partial<Api> = {}): Api & { starts: unknown[] } {
  const starts: unknown[] = [];
  return {
    starts,
    getConfig: async () => protectedConfig,
    startConversation: async (_v, _id, bot) => (starts.push(bot), { session: { conversationId: "c1", sessionToken: "t" }, messages: [] }),
    refresh: async (s) => s, typing: async () => {}, history: async () => [],
    uiEvent: async () => ({ id: "u", role: "user", createdAt: "t" }),
    send: async (_s, text, clientId) => ({ id: "m1", role: "user", text, createdAt: new Date().toISOString(), clientId }),
    wsUrl: () => "ws://x", streamUrl: () => "http://x",
    ...over,
  };
}
beforeEach(() => localStorage.clear());

describe("api: protection fields", () => {
  it("maps protection from the config and sends hp + turnstileToken on start; reads the error code", async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = createApi("https://x.test/api/v1", "wk_1", async (url, init) => {
      if (String(url).endsWith("/config")) {
        return new Response(JSON.stringify({ config: { protection: { honeypot: true, turnstile: { enabled: true, siteKey: "0xKEY", theme: "dark", size: "flexible", appearance: "interaction-only", action: "chat" } } } }));
      }
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ error: { code: "turnstile_failed", message: "x", requestId: "r" } }), { status: 403 });
    });
    const c = await api.getConfig();
    expect(c.protection).toEqual({ honeypot: true, turnstile: { siteKey: "0xKEY", theme: "dark", size: "flexible", appearance: "interaction-only", action: "chat" } });
    await expect(api.startConversation(undefined, undefined, { hp: "", turnstileToken: "tok" })).rejects.toMatchObject({ status: 403, code: "turnstile_failed" });
    expect(bodies[0]).toMatchObject({ turnstileToken: "tok" });
    expect(bodies[0]).not.toHaveProperty("hp"); // empty honeypot is not sent
  });
  it("turnstile disabled or without a site key means no challenge", async () => {
    const api = createApi("https://x.test/api/v1", "wk_1", async () => new Response(JSON.stringify({ config: { protection: { turnstile: { enabled: true, siteKey: "" } } } })));
    expect((await api.getConfig()).protection).toEqual({ honeypot: true, turnstile: undefined });
  });
});

describe("Chat: Turnstile gate and blocked visitors", () => {
  it("waits for the challenge before starting, then sends the token once", async () => {
    const api = fakeApi();
    const chat = new Chat(api, "k", { transport: noTransport });
    await chat.init();
    expect(chat.state.phase).toBe("ready"); // opening the chat starts nothing, so no challenge yet
    chat.send("hello");
    await vi.waitFor(() => expect(chat.state.phase).toBe("verify")); // the challenge comes with the first message
    expect(api.starts).toHaveLength(0);
    await chat.submitVerification("tok-1");
    expect(api.starts).toEqual([{ hp: "", turnstileToken: "tok-1" }]);
    expect(chat.state.phase).toBe("ready");
    chat.forget();
  });
  it("a rejected token goes back to the challenge; a blocked visitor sees the closed notice", async () => {
    let mode: "ts" | "blocked" = "ts";
    const api = fakeApi({
      startConversation: async () => {
        throw new ApiError(403, "HTTP 403", undefined, mode === "ts" ? "turnstile_failed" : "contact_blocked");
      },
    });
    const chat = new Chat(api, "k2", { transport: noTransport });
    await chat.init();
    chat.send("hello");
    await vi.waitFor(() => expect(chat.state.phase).toBe("verify"));
    await chat.submitVerification("expired");
    await vi.waitFor(() => expect(chat.state.phase).toBe("verify"));
    mode = "blocked";
    await chat.submitVerification("again");
    await vi.waitFor(() => expect(chat.state.phase).toBe("closed"));
    chat.forget();
  });
  it("keeps the closing message visible after the visitor is blocked mid-conversation", async () => {
    let blocked = false;
    const farewell = { id: "m2", role: "ai" as const, text: "This conversation is closed.", createdAt: new Date().toISOString() };
    const api = fakeApi({
      getConfig: async () => ({ ...protectedConfig, protection: { honeypot: true } }),
      history: async () => (blocked ? [farewell] : []),
      send: async () => {
        throw new ApiError(blocked ? 401 : 403, "HTTP", undefined, "contact_blocked");
      },
      startConversation: async () => {
        if (blocked) throw new ApiError(403, "HTTP 403", undefined, "contact_blocked");
        return { session: { conversationId: "c1", sessionToken: "t" }, messages: [] };
      },
    });
    const chat = new Chat(api, "k4", { transport: noTransport });
    await chat.init();
    chat.send("hello"); // the conversation starts with the first message
    await vi.waitFor(() => expect(chat.state.conn).not.toBe("offline"));
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("yulona:k4")!).session).toBeTruthy());
    blocked = true;
    await chat.sync(); // the closing message is read although the session was revoked with the block
    expect(chat.state.messages.map((m) => m.text)).toContain("This conversation is closed.");
    await chat.reset(); // what a later 401 does; the next start is refused
    await vi.waitFor(() => expect(chat.state.phase).toBe("closed"));
    expect(chat.state.messages.map((m) => m.text)).toContain("This conversation is closed.");
    chat.forget();
  });
  it("the honeypot value is forwarded; without Turnstile the chat starts immediately", async () => {
    const api = fakeApi({ getConfig: async () => ({ ...protectedConfig, protection: { honeypot: true } }) });
    const chat = new Chat(api, "k3", { transport: noTransport });
    chat.setHoneypot("http://spam");
    await chat.init();
    expect(api.starts).toHaveLength(0);
    chat.send("hi");
    await vi.waitFor(() => expect(api.starts).toEqual([{ hp: "http://spam", turnstileToken: undefined }]));
    chat.forget();
  });
});
