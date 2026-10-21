import type { ChannelCapability, ChannelType } from "@yulona/shared";
import { formatForCapability, isMessageWindowOpen } from "./format";
import { callApi, ChannelSendError, metaHandshake, safeJson, verifyMetaSignature, type AdapterOptions } from "./http";
import type { ChannelAdapter, InboundMessage, OutboundMessage, SendResult } from "./types";

const CAPS: ChannelCapability = {
  text: true, richCards: false, forms: false, fileUpload: false, typingIndicator: false,
  interactiveButtons: false, messageWindow: 24,
};
export const MESSENGER_CAPABILITIES = CAPS;
export const INSTAGRAM_CAPABILITIES = CAPS;

interface MetaFlavor {
  type: Extract<ChannelType, "facebook" | "instagram">;
  object: "page" | "instagram";
  base: string;
  tokenField: "pageAccessToken" | "accessToken";
  tokenLabel: string;
  senderField: "pageId" | "igUserId";
  senderLabel: string;
}

function createMetaAdapter(f: MetaFlavor, o: AdapterOptions & { apiBase?: string }): ChannelAdapter {
  const base = o.apiBase ?? f.base;
  return {
    type: f.type,
    capabilities: CAPS,
    credentialFields: [
      { name: f.tokenField, label: f.tokenLabel, secret: true, required: true },
      { name: f.senderField, label: f.senderLabel, secret: false, required: true },
      { name: "appSecret", label: "App secret", secret: true, required: true },
      { name: "verifyToken", label: "Webhook verify token", secret: true, required: false },
    ],
    handleVerification: (req, c) => metaHandshake(req.query, c.verifyToken),
    verifyWebhook: (req, c) => verifyMetaSignature(req.headers, req.rawBody, c?.appSecret),
    parseInbound(req): InboundMessage[] {
      const body = safeJson(req.rawBody);
      if (!body || body.object !== f.object) return [];
      const out: InboundMessage[] = [];
      for (const entry of body.entry ?? []) {
        for (const ev of entry?.messaging ?? []) {
          const m = ev?.message;
          if (!m || m.is_echo || !ev?.sender?.id || !m.mid) continue;
          const text = typeof m.text === "string" && m.text ? m.text : m.attachments?.length ? `[${String(m.attachments[0]?.type ?? "attachment")}]` : "";
          if (!text) continue;
          out.push({
            channel: f.type, externalContactId: String(ev.sender.id), externalMessageId: String(m.mid),
            text: text.slice(0, 4000), receivedAt: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(),
          });
        }
      }
      return out;
    },
    async send(msg: OutboundMessage, c): Promise<SendResult> {
      const token = c?.[f.tokenField];
      if (!token) throw new ChannelSendError(`${f.type} credentials incomplete`, "bad_credentials", false);
      if (!msg.externalContactId) throw new ChannelSendError("No recipient", "invalid_destination", false);
      if (!isMessageWindowOpen(CAPS, msg.lastCustomerMessageAt)) {
        throw new ChannelSendError(`${f.type} 24h reply window closed`, "window_closed", false);
      }
      const text = (msg.ui ? formatForCapability(msg.ui, CAPS).text : "") || msg.text;
      const data = await callApi(o, `${base}/me/messages`, {
        headers: { authorization: `Bearer ${token}` },
        body: { recipient: { id: msg.externalContactId }, messaging_type: "RESPONSE", message: { text: text.slice(0, 1900) } },
      }, `${f.type} send`);
      return { delivered: "channel", externalMessageId: data?.message_id };
    },
    async checkHealth(c) {
      const token = c[f.tokenField];
      if (!token) return { ok: false, detail: "missing credentials" };
      try {
        const d = await callApi(o, `${base}/me?fields=id`, { method: "GET", headers: { authorization: `Bearer ${token}` } }, `${f.type} health`);
        return { ok: true, detail: d?.id ? `Account ${d.id}` : "ok" };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}

export const createMessengerAdapter = (o: AdapterOptions & { apiBase?: string } = {}) =>
  createMetaAdapter({ type: "facebook", object: "page", base: "https://graph.facebook.com/v21.0", tokenField: "pageAccessToken", tokenLabel: "Page access token", senderField: "pageId", senderLabel: "Page ID" }, o);

export const createInstagramAdapter = (o: AdapterOptions & { apiBase?: string } = {}) =>
  createMetaAdapter({ type: "instagram", object: "instagram", base: "https://graph.instagram.com/v21.0", tokenField: "accessToken", tokenLabel: "Instagram access token", senderField: "igUserId", senderLabel: "Instagram account ID" }, o);
