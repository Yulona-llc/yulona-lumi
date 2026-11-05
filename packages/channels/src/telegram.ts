import type { ChannelCapability } from "@yulona/shared";
import { formatForCapability } from "./format";
import { callApi, ChannelSendError, constantTimeEqual, header, safeJson, type AdapterOptions } from "./http";
import type { ChannelAdapter, InboundMessage, OutboundMessage, SendResult } from "./types";

export const TELEGRAM_CAPABILITIES: ChannelCapability = {
  text: true, richCards: false, forms: false, fileUpload: false, typingIndicator: false,
  interactiveButtons: false, messageWindow: null,
};

/**
 * Telegram Bot API. Credentials: botToken, webhookSecret (registered with `setWebhook secret_token`;
 * Telegram echoes it in X-Telegram-Bot-Api-Secret-Token on every update).
 */
export function createTelegramAdapter(o: AdapterOptions & { apiBase?: string } = {}): ChannelAdapter {
  const base = o.apiBase ?? "https://api.telegram.org";
  const url = (token: string, method: string) => `${base}/bot${encodeURIComponent(token)}/${method}`;
  return {
    type: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,
    credentialFields: [
      { name: "botToken", label: "Bot token", secret: true, required: true },
      { name: "webhookSecret", label: "Webhook secret token", secret: true, required: false },
    ],
    verifyWebhook(req, c) {
      const got = header(req.headers, "x-telegram-bot-api-secret-token");
      return !!c?.webhookSecret && !!got && constantTimeEqual(got, c.webhookSecret);
    },
    parseInbound(req): InboundMessage[] {
      const u = safeJson(req.rawBody);
      const m = u?.message;
      if (!m || m.from?.is_bot || m.chat?.id === undefined || m.chat?.type !== "private") return [];
      const text = typeof m.text === "string" ? m.text : "[unsupported message]";
      const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username;
      return [{
        channel: "telegram", externalContactId: String(m.chat.id),
        // update_id is unique per bot; message_id is only unique per chat.
        externalMessageId: u.update_id !== undefined ? String(u.update_id) : `${m.chat.id}:${m.message_id}`,
        text: text.slice(0, 4000), displayName: name || undefined, receivedAt: m.date ? new Date(Number(m.date) * 1000) : new Date(),
      }];
    },
    async send(msg: OutboundMessage, c): Promise<SendResult> {
      if (!c?.botToken) throw new ChannelSendError("Telegram credentials incomplete", "bad_credentials", false);
      if (!msg.externalContactId) throw new ChannelSendError("No Telegram chat", "invalid_destination", false);
      const text = (msg.ui ? formatForCapability(msg.ui, TELEGRAM_CAPABILITIES).text : "") || msg.text;
      const d = await callApi(o, url(c.botToken, "sendMessage"), { body: { chat_id: msg.externalContactId, text: text.slice(0, 4096) } }, "telegram send");
      if (d && d.ok === false) throw new ChannelSendError("telegram send: rejected", "rejected", false);
      return { delivered: "channel", externalMessageId: d?.result?.message_id !== undefined ? String(d.result.message_id) : undefined };
    },
    async registerWebhook(c, webhookUrl) {
      if (!c.botToken) return { ok: false, detail: "missing bot token" };
      try {
        const d = await callApi(o, url(c.botToken, "setWebhook"), {
          body: { url: webhookUrl, allowed_updates: ["message"], ...(c.webhookSecret ? { secret_token: c.webhookSecret } : {}) },
        }, "telegram setWebhook");
        return d?.ok ? { ok: true, detail: "Webhook registered with Telegram" } : { ok: false, detail: typeof d?.description === "string" ? d.description.slice(0, 200) : "Telegram rejected the webhook" };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    async checkHealth(c) {
      if (!c.botToken) return { ok: false, detail: "missing credentials" };
      try {
        const d = await callApi(o, url(c.botToken, "getMe"), { method: "GET" }, "telegram health");
        return d?.ok ? { ok: true, detail: `Bot @${d.result?.username ?? "unknown"}` } : { ok: false, detail: "getMe failed" };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
