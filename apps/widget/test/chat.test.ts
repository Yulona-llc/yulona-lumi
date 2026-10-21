import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../src/api";
import { Chat } from "../src/chat";
import type { WireMessage } from "../src/types";

function fakeApi(over: Partial<Api> = {}): Api & { sent: string[] } {
  const sent: string[] = [];
  let n = 0;
  return {
    sent,
    getConfig: async () => ({ title: "T", primaryColor: "#4f46e5", position: "right", theme: "light" }),
    startConversation: async () => ({
      session: { conversationId: "c1", sessionToken: "t" },
      messages: [{ id: "w1", role: "ai", text: "hello", createdAt: "2020-01-01T00:00:00Z" }],
    }),
    refresh: async (s) => s,
    typing: async () => {},
    uiEvent: async (_s, e) => ({ id: "u1", role: "user", text: e.kind, createdAt: new Date().toISOString() }),
    history: async () => [],
    send: async (_s, text, clientId) => {
      sent.push(text);
      return { id: `m${++n}`, role: "user", text, createdAt: new Date().toISOString(), clientId } as WireMessage;
    },
    wsUrl: () => "ws://x",
    streamUrl: () => "http://x",
    ...over,
  };
}
const noTransport = () => ({ stop() {} });

beforeEach(() => localStorage.clear());

describe("Chat", () => {
  it("shows greeting then sends optimistically and reconciles", async () => {
    const api = fakeApi();
    const chat = new Chat(api, "k", { transport: noTransport });
    await chat.init();
    expect(chat.state.messages[0]?.text).toBe("hello"); // welcome message from POST /conversations
    chat.send("  hi  ");
    expect(chat.state.messages.at(-1)?.state).toBe("sending");
    await vi.waitFor(() => expect(api.sent).toEqual(["hi"]));
    await vi.waitFor(() => expect(chat.state.messages.at(-1)?.state).toBe("sent"));
    expect(chat.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    chat.forget();
  });

  it("queues while offline, persists the outbox, and flushes on retry", async () => {
    let fail = true;
    const api = fakeApi({
      send: async (_s, text, clientId) => {
        if (fail) throw new ApiError(0, "network");
        return { id: "m9", role: "user", text, createdAt: new Date().toISOString(), clientId } as WireMessage;
      },
    });
    const chat = new Chat(api, "k2", { transport: noTransport, retryBase: 10 });
    await chat.init();
    chat.send("offline msg");
    await vi.waitFor(() => expect(chat.state.conn).toBe("offline"));
    expect(JSON.parse(localStorage.getItem("yulona:k2")!).outbox).toHaveLength(1);
    fail = false;
    await vi.waitFor(() => expect(chat.state.messages.at(-1)?.state).toBe("sent"), { timeout: 2000 });
    expect(JSON.parse(localStorage.getItem("yulona:k2")!).outbox).toHaveLength(0);
    chat.forget();
  });

  it("marks non-retryable failures as failed and does not retry forever", async () => {
    const api = fakeApi({ send: async () => { throw new ApiError(422, "bad"); } });
    const chat = new Chat(api, "k3", { transport: noTransport });
    await chat.init();
    chat.send("x");
    await vi.waitFor(() => expect(chat.state.messages.at(-1)?.state).toBe("failed"));
    chat.forget();
  });

  it("requires pre-chat before creating a conversation", async () => {
    let started = 0;
    const api = fakeApi({
      getConfig: async () => ({ title: "T", primaryColor: "#000000", position: "right", theme: "light", preChat: { enabled: true, fields: [] } }),
      startConversation: async () => (started++, { session: { conversationId: "c", sessionToken: "t" }, messages: [] }),
    });
    const chat = new Chat(api, "k4", { transport: noTransport });
    await chat.init();
    expect(chat.state.phase).toBe("prechat");
    expect(started).toBe(0);
    await chat.submitPreChat({ name: "A" });
    expect(started).toBe(1);
    expect(chat.state.phase).toBe("ready");
    chat.forget();
  });

  it("restarts the conversation on an expired session (401)", async () => {
    localStorage.setItem("yulona:k5", JSON.stringify({ outbox: [], session: { conversationId: "old", sessionToken: "x" } }));
    let calls = 0;
    const api = fakeApi({
      history: async (s) => {
        if (s.conversationId === "old") { calls++; throw new ApiError(401, "expired"); }
        return [];
      },
    });
    const chat = new Chat(api, "k5", { transport: noTransport });
    await chat.init();
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("yulona:k5")!).session.conversationId).toBe("c1"));
    expect(calls).toBe(1);
    chat.forget();
  });
});
