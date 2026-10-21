import { describe, expect, it } from "vitest";
import { createApi, resolveApiBase } from "../src/api";
import { parseFrame } from "../src/transport";

describe("api base", () => {
  it("treats a bare origin from the embed snippet as the API root", () => {
    expect(resolveApiBase("http://localhost:3000", "http://localhost:4180")).toBe("http://localhost:3000/api/v1");
    expect(resolveApiBase("http://localhost:3000/api/v1/", "http://localhost:4180")).toBe("http://localhost:3000/api/v1");
    expect(resolveApiBase(undefined, "http://localhost:4180")).toBe("http://localhost:4180/api/v1");
  });
});

describe("api contract mapping", () => {
  it("maps config + prechat and sends X-Widget-Key", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const api = createApi("https://x.test/api/v1/", "wk_1", async (url, init) => {
      seen = { url: String(url), headers: init!.headers as Record<string, string> };
      return new Response(JSON.stringify({ name: "N", config: { title: "Hi", primaryColor: "#112233", theme: "auto", position: "left" }, prechat: { enabled: true, fields: [{ name: "email", label: "E", required: true }] }, schemaVersion: 1 }));
    });
    const c = await api.getConfig();
    expect(seen!.url).toBe("https://x.test/api/v1/public/widget/config");
    expect(seen!.headers["x-widget-key"]).toBe("wk_1");
    expect(c).toMatchObject({ title: "Hi", theme: "auto", position: "left", preChat: { fields: [{ name: "email", kind: "email", required: true }] } });
    expect(api.wsUrl()).toBe("wss://x.test/api/v1/public/widget/ws?key=wk_1");
  });
  it("builds spec-shaped ui-event bodies", async () => {
    let body: Record<string, unknown> = {};
    const api = createApi("https://x.test/api/v1", "k", async (_u, init) => {
      body = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ id: "i", senderType: "contact", content: "c", createdAt: "t" }), { status: 201 });
    });
    const s = { conversationId: "c", sessionToken: "t" };
    await api.uiEvent(s, { messageId: "m", componentId: "cal", kind: "calendar", payload: { start: "a", end: "b", timezone: "UTC" } }, "cid-12345678");
    expect(body).toMatchObject({ type: "calendar_select", messageId: "m", clientMessageId: "cid-12345678", start: "a", timezone: "UTC" });
  });
});

describe("realtime frames", () => {
  it("maps message.created and typing, ignores unknown", () => {
    const m = parseFrame(JSON.stringify({ type: "message.created", conversationId: "c", message: { id: "1", senderType: "ai", content: "yo", createdAt: "t" } }));
    expect(m).toMatchObject({ type: "message", message: { role: "ai", text: "yo" } });
    expect(parseFrame('{"type":"typing","from":"ai","typing":true}')).toMatchObject({ type: "typing", on: true });
    expect(parseFrame('{"type":"presence"}')).toBeUndefined();
    expect(parseFrame("not json")).toBeUndefined();
    expect(parseFrame('{"type":"ready","kind":"visitor"}')).toBe("ready");
    expect(parseFrame('{"type":"error","code":"unauthorized"}')).toBe("unauthorized");
    expect(parseFrame('{"x":1}', "message.created")).toBeUndefined();
  });
});
