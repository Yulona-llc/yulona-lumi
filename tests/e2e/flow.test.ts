import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJobHandlers, createMockPorts } from "@yulona/ai-runtime";
import { startWorker, type Worker } from "@yulona/queue";
import { websocket } from "hono/bun";
import { ORIGIN, PASSWORD, boot, hasDb, jsonOf, type Booted } from "../support";

/**
 * End-to-end: register -> agent + knowledge -> widget -> public conversation -> AI answers from KB ->
 * low-confidence question => pending_human -> human takeover reply seen over SSE -> return to AI.
 * Real Postgres, real HTTP server, in-process worker, mock LLM/embeddings.
 */
describe.skipIf(!hasDb)("e2e: widget conversation lifecycle", () => {
  let b: Booted, server: ReturnType<typeof Bun.serve>, worker: Worker;
  const base = () => `http://localhost:${server.port}/api/v1`;
  const call = (method: string, path: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base()}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const r = await fn(); if (r) return r as T; await Bun.sleep(300); }
    throw new Error("timeout");
  };

  beforeAll(async () => {
    b = await boot();
    server = Bun.serve({ port: 0, fetch: b.app.fetch, websocket: websocket as never, idleTimeout: 30 });
    const ports = createMockPorts();
    worker = startWorker(b.db, createJobHandlers({ db: b.db, ports }) as never, { pollIntervalMs: 30, concurrency: 4 });
  });
  afterAll(async () => { await worker?.stop(); server?.stop(true); await b.close(); });

  test("full lifecycle", async () => {
    // 1. register
    const reg = await call("POST", "/auth/register", null, { email: `e2e-${crypto.randomUUID().slice(0, 8)}@example.test`, password: PASSWORD, name: "Ada", workspaceName: "E2E Co" });
    expect(reg.status).toBe(201);
    const { accessToken: token, tenant } = await jsonOf<{ accessToken: string; tenant: { id: string } }>(reg);

    // 2. agent + knowledge (text) -> ingestion by the worker -> ready
    const agent = await jsonOf<{ id: string }>(await call("POST", "/agents", token, { name: "Support" }));
    expect(agent.id).toBeTruthy();
    expect((await call("POST", `/agents/${agent.id}/publish`, token, {})).status).toBe(200); // only a published agent answers customers
    const ids: string[] = [];
    for (const [name, text] of [["Opening", "The shop opens at nine in the morning."], ["Closing", "The shop closes at six in the evening."]] as const) {
      const src = await call("POST", "/knowledge/sources/text", token, { name, text, agentId: agent.id });
      expect(src.status).toBe(201);
      ids.push((await jsonOf<{ id: string }>(src)).id);
    }
    for (const id of ids) await until(async () => (await jsonOf<{ status: string }>(await call("GET", `/knowledge/sources/${id}`, token))).status === "ready");

    // 3. widget config
    const w = await jsonOf<{ id: string; widgetKey: string }>(await call("POST", "/widgets", token, { name: "Site", agentId: agent.id, allowedDomains: [ORIGIN], config: { welcomeMessage: "Hello!" } }));
    expect(w.widgetKey).toMatch(/^wk_/);
    const pubH = { "x-widget-key": w.widgetKey, origin: ORIGIN, "content-type": "application/json" };
    const cfg = await fetch(`${base()}/public/widget/config`, { headers: pubH });
    expect(cfg.status).toBe(200);

    // 4. public conversation + grounded AI answer
    const start = await jsonOf<{ sessionToken: string; conversation: { id: string } }>(await fetch(`${base()}/public/widget/conversations`, { method: "POST", headers: pubH, body: JSON.stringify({ visitor: { email: "v@example.test", name: "Vi" } }) }));
    const sH = { ...pubH, authorization: `Bearer ${start.sessionToken}` };
    const convId = start.conversation.id;
    const post = (text: string, n: number) => fetch(`${base()}/public/widget/messages`, { method: "POST", headers: sH, body: JSON.stringify({ text, clientMessageId: `e2e-msg-${String(n).padStart(4, "0")}` }) });
    const history = async () => { const r = await fetch(`${base()}/public/widget/messages`, { headers: sH }); if (r.status !== 200) throw new Error(`history ${r.status} ${await r.text()}`); return (await jsonOf<{ items: { senderType: string; content: string }[]; conversation: { status: string } }>(r)); };
    expect((await post("The shop opens at nine in the morning?", 1)).status).toBe(201);
    const answered = await until(async () => (await history()).items.find((m) => m.senderType === "ai" && m.content !== "Hello!"));
    expect(answered.content.toLowerCase()).toContain("nine in the morning");

    // 5. low-confidence question => handoff, AI stops
    // (default maxUnansweredTurns = 3: two clarifying replies, then the handoff)
    for (const n of [2, 3, 4]) {
      const before = (await history()).items.filter((m) => m.senderType === "ai").length;
      expect((await post(`Zyxwvut quplomb fnargle blorptastic ${n}?`, n)).status).toBe(201);
      await until(async () => (await history()).items.filter((m) => m.senderType === "ai").length > before); // one reply per turn
    }
    await until(async () => (await jsonOf<{ status: string }>(await call("GET", `/conversations/${convId}`, token))).status === "pending_human");
    const aiCountBefore = (await history()).items.filter((m) => m.senderType === "ai" && m.content !== "Hello!").length;
    expect((await jsonOf<{ items: { type: string }[] }>(await call("GET", "/needs-attention", token))).items.length).toBeGreaterThan(0);

    // 6. human takeover reply visible to the visitor over SSE
    const sse = await fetch(`${base()}/public/widget/stream`, { headers: sH });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader(); const dec = new TextDecoder(); let text = "";
    const readUntil = async (needle: string) => {
      const end = Date.now() + 6000;
      while (!text.includes(needle) && Date.now() < end) { const r = await Promise.race([reader.read(), Bun.sleep(300).then(() => null)]); if (r && !r.done) text += dec.decode(r.value); }
      expect(text).toContain(needle);
    };
    await readUntil("event: ready");
    expect((await call("POST", `/conversations/${convId}/takeover`, token)).status).toBe(200);
    expect((await call("POST", `/conversations/${convId}/messages`, token, { text: "Hi, a human here, happy to help" })).status).toBe(201);
    await readUntil("a human here");
    await reader.cancel();
    expect((await history()).items.filter((m) => m.senderType === "ai" && m.content !== "Hello!").length).toBe(aiCountBefore); // AI silent while human handles

    // 7. return to AI -> AI answers again
    const back = await jsonOf<{ handler: string; status: string }>(await call("POST", `/conversations/${convId}/return-to-ai`, token));
    expect(back.handler).toBe("ai");
    expect((await post("The shop closes at six in the evening?", 5)).status).toBe(201);
    await until(async () => (await history()).items.filter((m) => m.senderType === "ai" && m.content !== "Hello!").length > aiCountBefore);

    // tenant data stayed in this tenant
    const [n] = await b.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${convId} AND tenant_id <> ${tenant.id}`;
    expect(n!.n).toBe(0);
  }, 60_000);
});
