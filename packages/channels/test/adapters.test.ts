import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ChannelSendError, constantTimeEqual, createInstagramAdapter, createMessengerAdapter, createSlackAdapter, createTelegramAdapter,
  createWhatsAppAdapter, type ChannelAdapter, type WebhookRequest,
} from "../src";

interface Recorded { method: string; path: string; headers: Record<string, string>; body: any }
let server: ReturnType<typeof Bun.serve>;
let base = "";
let seen: Recorded[] = [];
let respond: (path: string) => { status: number; json: unknown } = () => ({ status: 200, json: {} });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({ method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers.entries()), body: text ? JSON.parse(text) : null });
      const r = respond(url.pathname);
      return Response.json(r.json, { status: r.status });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  respond = () => ({ status: 200, json: {} });
});

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const req = (rawBody: string, headers: Record<string, string> = {}, query?: Record<string, string>): WebhookRequest => ({ rawBody, headers, query });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe("constantTimeEqual", () => {
  test("equal / different / different length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("WhatsApp", () => {
  const a = createWhatsAppAdapter({ apiBase: base || "http://x" });
  const creds = { accessToken: "tok", phoneNumberId: "123", appSecret: "shh", verifyToken: "vt" };
  const payload = JSON.stringify({
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "251911000111", profile: { name: "Abebe" } }],
      messages: [{ from: "251911000111", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "hello" } },
                 { from: "251911000111", id: "wamid.2", timestamp: "1700000001", type: "image" }],
    } }] }],
  });

  test("signature: valid, tampered, missing, wrong secret, no secret", () => {
    expect(a.verifyWebhook(req(payload, { "x-hub-signature-256": sign("shh", payload) }), creds)).toBe(true);
    expect(a.verifyWebhook(req(payload + " ", { "X-Hub-Signature-256": sign("shh", payload) }), creds)).toBe(false);
    expect(a.verifyWebhook(req(payload, {}), creds)).toBe(false);
    expect(a.verifyWebhook(req(payload, { "x-hub-signature-256": sign("other", payload) }), creds)).toBe(false);
    expect(a.verifyWebhook(req(payload, { "x-hub-signature-256": sign("shh", payload) }), { ...creds, appSecret: "" })).toBe(false);
    expect(a.verifyWebhook(req(payload, { "x-hub-signature-256": "sha1=abc" }), creds)).toBe(false);
  });
  test("handshake", () => {
    expect(a.handleVerification!(req("", {}, { "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "42" }), creds)).toEqual({ status: 200, body: "42" });
    expect(a.handleVerification!(req("", {}, { "hub.mode": "subscribe", "hub.verify_token": "bad", "hub.challenge": "42" }), creds)?.status).toBe(403);
    expect(a.handleVerification!(req("", {}, {}), creds)).toBeNull();
  });
  test("parseInbound: text, attachment placeholder, phone, name", () => {
    const m = a.parseInbound(req(payload));
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ channel: "whatsapp", externalContactId: "251911000111", externalMessageId: "wamid.1", text: "hello", displayName: "Abebe", phone: "+251911000111" });
    expect(m[1]!.text).toBe("[image message]");
    expect(a.parseInbound(req("not json"))).toEqual([]);
  });
  test("send inside window uses text endpoint with bearer token", async () => {
    const w = createWhatsAppAdapter({ apiBase: base });
    respond = () => ({ status: 200, json: { messages: [{ id: "wamid.out" }] } });
    const r = await w.send({ conversationId: "c", externalContactId: "251911000111", text: "hi", lastCustomerMessageAt: hoursAgo(1) }, creds);
    expect(r).toEqual({ delivered: "channel", externalMessageId: "wamid.out", usedTemplate: false });
    expect(seen[0]!.path).toBe("/123/messages");
    expect(seen[0]!.headers.authorization).toBe("Bearer tok");
    expect(seen[0]!.body).toMatchObject({ type: "text", to: "251911000111", text: { body: "hi" } });
  });
  test("window closed: template fallback when configured, else non-retryable window_closed", async () => {
    const w = createWhatsAppAdapter({ apiBase: base });
    const old = { conversationId: "c", externalContactId: "251911000111", text: "follow up\nplease", lastCustomerMessageAt: hoursAgo(30) };
    const err = await w.send(old, creds).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelSendError);
    expect(err).toMatchObject({ code: "window_closed", retryable: false });
    expect(seen).toHaveLength(0); // nothing leaves the building outside the window without a template
    const r = await w.send(old, { ...creds, templateName: "followup", templateLanguage: "en" });
    expect(r.usedTemplate).toBe(true);
    expect(seen[0]!.body.template).toMatchObject({ name: "followup", language: { code: "en" } });
    expect(seen[0]!.body.template.components[0].parameters[0].text).toBe("follow up please");
    expect(await w.send({ ...old, lastCustomerMessageAt: null }, creds).catch((e) => e.code)).toBe("window_closed");
  });
  test("error mapping: 5xx/429 retryable, 4xx rejected, 401 bad_credentials", async () => {
    const w = createWhatsAppAdapter({ apiBase: base });
    const m = { conversationId: "c", externalContactId: "1", text: "x", lastCustomerMessageAt: new Date() };
    for (const [status, code, retry] of [[500, "unavailable", true], [429, "unavailable", true], [400, "rejected", false], [401, "bad_credentials", false]] as const) {
      respond = () => ({ status, json: { error: { message: "nope" } } });
      expect(await w.send(m, creds).catch((e) => e)).toMatchObject({ code, retryable: retry });
    }
  });
  test("network failure is retryable", async () => {
    const w = createWhatsAppAdapter({ apiBase: "http://127.0.0.1:1" });
    expect(await w.send({ conversationId: "c", externalContactId: "1", text: "x", lastCustomerMessageAt: new Date() }, creds).catch((e) => e)).toMatchObject({ retryable: true });
  });
  test("health check", async () => {
    const w = createWhatsAppAdapter({ apiBase: base });
    respond = () => ({ status: 200, json: { display_phone_number: "+251 91" } });
    expect((await w.checkHealth!(creds)).ok).toBe(true);
    respond = () => ({ status: 401, json: {} });
    expect((await w.checkHealth!(creds)).ok).toBe(false);
  });
});

describe.each([
  ["facebook", createMessengerAdapter, "page", "pageAccessToken", "pageId"],
  ["instagram", createInstagramAdapter, "instagram", "accessToken", "igUserId"],
] as const)("Meta %s", (type, factory, object, tokenField, idField) => {
  const creds = { [tokenField]: "tok", [idField]: "1", appSecret: "shh", verifyToken: "vt" } as Record<string, string>;
  const body = JSON.stringify({
    object,
    entry: [{ messaging: [
      { sender: { id: "psid1" }, timestamp: 1700000000000, message: { mid: "m1", text: "hi there" } },
      { sender: { id: "page" }, message: { mid: "m2", text: "echo", is_echo: true } },
      { sender: { id: "psid1" }, message: { mid: "m3", attachments: [{ type: "image" }] } },
      { sender: { id: "psid1" }, message: { mid: "m4" } },
    ] }],
  });
  test("verify + parse (ignores echoes, wrong object)", () => {
    const a: ChannelAdapter = factory({ apiBase: base });
    expect(a.type).toBe(type);
    expect(a.verifyWebhook(req(body, { "x-hub-signature-256": sign("shh", body) }), creds)).toBe(true);
    expect(a.verifyWebhook(req(body, { "x-hub-signature-256": sign("nope", body) }), creds)).toBe(false);
    const m = a.parseInbound(req(body));
    expect(m.map((x) => [x.externalMessageId, x.text])).toEqual([["m1", "hi there"], ["m3", "[image]"]]);
    expect(a.parseInbound(req(JSON.stringify({ object: "other", entry: [] })))).toEqual([]);
  });
  test("send within window; closed window rejected without calling the API", async () => {
    const a = factory({ apiBase: base });
    respond = () => ({ status: 200, json: { message_id: "out1" } });
    const r = await a.send({ conversationId: "c", externalContactId: "psid1", text: "yo", lastCustomerMessageAt: hoursAgo(2) }, creds);
    expect(r.externalMessageId).toBe("out1");
    expect(seen[0]!.path).toBe("/me/messages");
    expect(seen[0]!.body).toMatchObject({ recipient: { id: "psid1" }, message: { text: "yo" } });
    seen = [];
    expect(await a.send({ conversationId: "c", externalContactId: "psid1", text: "yo", lastCustomerMessageAt: hoursAgo(25) }, creds).catch((e) => e.code)).toBe("window_closed");
    expect(seen).toHaveLength(0);
  });
});

describe("Telegram", () => {
  const a = createTelegramAdapter({ apiBase: base || "http://x" });
  const creds = { botToken: "123:ABC", webhookSecret: "sekret" };
  const upd = JSON.stringify({ update_id: 77, message: { message_id: 5, date: 1700000000, chat: { id: 999, type: "private" }, from: { id: 999, first_name: "Sara", last_name: "T" }, text: "hello" } });
  test("secret header constant-time check", () => {
    expect(a.verifyWebhook(req(upd, { "x-telegram-bot-api-secret-token": "sekret" }), creds)).toBe(true);
    expect(a.verifyWebhook(req(upd, { "X-Telegram-Bot-Api-Secret-Token": "wrong" }), creds)).toBe(false);
    expect(a.verifyWebhook(req(upd, {}), creds)).toBe(false);
    expect(a.verifyWebhook(req(upd, { "x-telegram-bot-api-secret-token": "" }), { ...creds, webhookSecret: "" })).toBe(false);
  });
  test("parse: private chat only, ignores bots/groups", () => {
    expect(a.parseInbound(req(upd))[0]).toMatchObject({ channel: "telegram", externalContactId: "999", externalMessageId: "77", text: "hello", displayName: "Sara T" });
    expect(a.parseInbound(req(JSON.stringify({ update_id: 1, message: { chat: { id: 1, type: "group" }, text: "x" } })))).toEqual([]);
    expect(a.parseInbound(req(JSON.stringify({ update_id: 1, message: { chat: { id: 1, type: "private" }, from: { is_bot: true }, text: "x" } })))).toEqual([]);
    expect(a.parseInbound(req(JSON.stringify({ update_id: 1, edited_message: {} })))).toEqual([]);
  });
  test("send hits /bot<token>/sendMessage", async () => {
    const t = createTelegramAdapter({ apiBase: base });
    respond = () => ({ status: 200, json: { ok: true, result: { message_id: 12 } } });
    const r = await t.send({ conversationId: "c", externalContactId: "999", text: "hi" }, creds);
    expect(r.externalMessageId).toBe("12");
    expect(["/bot123:ABC/sendMessage", "/bot123%3AABC/sendMessage"]).toContain(seen[0]!.path);
    expect(seen[0]!.body).toEqual({ chat_id: "999", text: "hi" });
    respond = () => ({ status: 400, json: { description: "chat not found" } });
    expect(await t.send({ conversationId: "c", externalContactId: "999", text: "hi" }, creds).catch((e) => e)).toMatchObject({ retryable: false, code: "rejected" });
  });
});

describe("Slack", () => {
  const secret = "slack-signing";
  const T = 1_700_000_000_000;
  const a = createSlackAdapter({ apiBase: base || "http://x", now: () => T });
  const creds = { botToken: "xoxb-1", signingSecret: secret };
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hey", ts: "1700000000.0001" } });
  const slackSig = (ts: string, b: string) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex")}`;
  const ts = String(T / 1000);

  test("valid signature; tamper; wrong secret", () => {
    expect(a.verifyWebhook(req(body, { "x-slack-request-timestamp": ts, "x-slack-signature": slackSig(ts, body) }), creds)).toBe(true);
    expect(a.verifyWebhook(req(body + "x", { "x-slack-request-timestamp": ts, "x-slack-signature": slackSig(ts, body) }), creds)).toBe(false);
    expect(a.verifyWebhook(req(body, { "x-slack-request-timestamp": ts, "x-slack-signature": slackSig(ts, body) }), { ...creds, signingSecret: "z" })).toBe(false);
  });
  test("replay protection: stale and future timestamps rejected even with a valid signature", () => {
    for (const skew of [-301, 301, -86_400]) {
      const t = String(T / 1000 + skew);
      expect(a.verifyWebhook(req(body, { "x-slack-request-timestamp": t, "x-slack-signature": slackSig(t, body) }), creds)).toBe(false);
    }
    const ok = String(T / 1000 - 299);
    expect(a.verifyWebhook(req(body, { "x-slack-request-timestamp": ok, "x-slack-signature": slackSig(ok, body) }), creds)).toBe(true);
    expect(a.verifyWebhook(req(body, { "x-slack-request-timestamp": "abc", "x-slack-signature": "v0=1" }), creds)).toBe(false);
  });
  test("url_verification and parse", () => {
    expect(a.respondToPost!(req(JSON.stringify({ type: "url_verification", challenge: "ch" })))).toMatchObject({ status: 200, body: '{"challenge":"ch"}' });
    expect(a.respondToPost!(req(body))).toBeNull();
    expect(a.parseInbound(req(body))[0]).toMatchObject({ channel: "slack", externalContactId: "D1:U1", externalMessageId: "Ev1", text: "hey" });
    const bot = JSON.stringify({ type: "event_callback", event: { type: "message", channel: "D1", bot_id: "B1", user: "U1", text: "x" } });
    expect(a.parseInbound(req(bot))).toEqual([]);
    const edited = JSON.stringify({ type: "event_callback", event: { type: "message", subtype: "message_changed", channel: "D1", user: "U1" } });
    expect(a.parseInbound(req(edited))).toEqual([]);
  });
  test("send: ok:false maps to errors", async () => {
    const s = createSlackAdapter({ apiBase: base });
    respond = () => ({ status: 200, json: { ok: true, ts: "1.2" } });
    expect((await s.send({ conversationId: "c", externalContactId: "D1:U1", text: "hi" }, creds)).externalMessageId).toBe("1.2");
    expect(seen[0]!.body).toEqual({ channel: "D1", text: "hi" });
    respond = () => ({ status: 200, json: { ok: false, error: "invalid_auth" } });
    expect(await s.send({ conversationId: "c", externalContactId: "D1:U1", text: "hi" }, creds).catch((e) => e)).toMatchObject({ code: "bad_credentials", retryable: false });
    respond = () => ({ status: 200, json: { ok: false, error: "ratelimited" } });
    expect(await s.send({ conversationId: "c", externalContactId: "D1:U1", text: "hi" }, creds).catch((e) => e)).toMatchObject({ retryable: true });
  });
});
