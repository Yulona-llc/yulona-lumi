import { isMessageWindowOpen, formatForCapability } from "./format";
import { callApi, ChannelSendError, metaHandshake, safeJson, verifyMetaSignature, type AdapterOptions } from "./http";
import type { ChannelAdapter, InboundMessage, OutboundMessage, SendResult } from "./types";
import type { ChannelCapability } from "@yulona/shared";

export const WHATSAPP_CAPABILITIES: ChannelCapability = {
  text: true, richCards: false, forms: false, fileUpload: false, typingIndicator: false,
  interactiveButtons: false, messageWindow: 24,
};

const API = "https://graph.facebook.com/v21.0";

/**
 * WhatsApp Cloud API. Credentials: accessToken, phoneNumberId, appSecret, verifyToken and optionally
 * templateName/templateLanguage (used when the 24h customer-service window is closed; the template
 * must have exactly one body variable that receives the message text).
 */
export function createWhatsAppAdapter(o: AdapterOptions & { apiBase?: string } = {}): ChannelAdapter {
  const base = o.apiBase ?? API;
  return {
    type: "whatsapp",
    capabilities: WHATSAPP_CAPABILITIES,
    credentialFields: [
      { name: "accessToken", label: "Access token", secret: true, required: true },
      { name: "phoneNumberId", label: "Phone number ID", secret: false, required: true },
      { name: "appSecret", label: "App secret", secret: true, required: true },
      { name: "verifyToken", label: "Webhook verify token", secret: true, required: false },
      { name: "templateName", label: "Fallback template name", secret: false, required: false },
      { name: "templateLanguage", label: "Fallback template language", secret: false, required: false },
    ],
    handleVerification: (req, c) => metaHandshake(req.query, c.verifyToken),
    verifyWebhook: (req, c) => verifyMetaSignature(req.headers, req.rawBody, c?.appSecret),
    parseInbound(req): InboundMessage[] {
      const body = safeJson(req.rawBody);
      const out: InboundMessage[] = [];
      for (const entry of body?.entry ?? []) {
        for (const ch of entry?.changes ?? []) {
          const v = ch?.value;
          const names = new Map<string, string>();
          for (const c of v?.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), String(c?.profile?.name ?? ""));
          for (const m of v?.messages ?? []) {
            if (!m?.from || !m?.id) continue;
            const from = String(m.from);
            const text = m.type === "text" ? String(m.text?.body ?? "")
              : m.type === "button" ? String(m.button?.text ?? "")
              : m.type === "interactive" ? String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "")
              : `[${String(m.type ?? "unsupported")} message]`;
            out.push({
              channel: "whatsapp", externalContactId: from, externalMessageId: String(m.id), text: text.slice(0, 4000),
              displayName: names.get(from) || undefined, phone: `+${from.replace(/\D/g, "")}`,
              receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
            });
          }
        }
      }
      return out;
    },
    async send(msg: OutboundMessage, c): Promise<SendResult> {
      if (!c?.accessToken || !c.phoneNumberId) throw new ChannelSendError("WhatsApp credentials incomplete", "bad_credentials", false);
      if (!msg.externalContactId) throw new ChannelSendError("No WhatsApp recipient", "invalid_destination", false);
      const text = (msg.ui ? formatForCapability(msg.ui, WHATSAPP_CAPABILITIES).text : "") || msg.text;
      const auth = { authorization: `Bearer ${c.accessToken}` };
      const url = `${base}/${encodeURIComponent(c.phoneNumberId)}/messages`;
      const open = isMessageWindowOpen(WHATSAPP_CAPABILITIES, msg.lastCustomerMessageAt);
      if (!open && !c.templateName) {
        throw new ChannelSendError("WhatsApp 24h window closed and no fallback template configured", "window_closed", false);
      }
      const payload = open
        ? { messaging_product: "whatsapp", to: msg.externalContactId, type: "text", text: { body: text.slice(0, 4096), preview_url: false } }
        : {
            messaging_product: "whatsapp", to: msg.externalContactId, type: "template",
            template: {
              name: c.templateName, language: { code: c.templateLanguage || "en_US" },
              components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\s+/g, " ").slice(0, 1024) }] }],
            },
          };
      const data = await callApi(o, url, { headers: auth, body: payload }, "whatsapp send");
      return { delivered: "channel", externalMessageId: data?.messages?.[0]?.id, usedTemplate: !open };
    },
    async checkHealth(c) {
      if (!c.accessToken || !c.phoneNumberId) return { ok: false, detail: "missing credentials" };
      try {
        const d = await callApi(o, `${base}/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number`, { method: "GET", headers: { authorization: `Bearer ${c.accessToken}` } }, "whatsapp health");
        return { ok: true, detail: d?.display_phone_number ? `Number ${d.display_phone_number}` : "ok" };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
