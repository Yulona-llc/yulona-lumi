import type { ChannelCapability } from "@yulona/shared";
import { formatForCapability } from "./format";
import { callApi, ChannelSendError, constantTimeEqual, header, hmacHex, safeJson, type AdapterOptions } from "./http";
import type { ChannelAdapter, InboundMessage, OutboundMessage, SendResult } from "./types";

export const SLACK_CAPABILITIES: ChannelCapability = {
  text: true, richCards: false, forms: false, fileUpload: false, typingIndicator: false,
  interactiveButtons: false, messageWindow: null,
};

/** Maximum clock skew accepted on `X-Slack-Request-Timestamp` (replay protection, per Slack docs). */
export const SLACK_MAX_SKEW_SECONDS = 300;

/**
 * Slack Events API (direct messages to the app). Credentials: botToken (xoxb-), signingSecret.
 * `externalContactId` is `<channelId>:<userId>` so replies can be posted to the right DM.
 */
export function createSlackAdapter(o: AdapterOptions & { apiBase?: string; now?: () => number } = {}): ChannelAdapter {
  const base = o.apiBase ?? "https://slack.com/api";
  const now = o.now ?? (() => Date.now());
  return {
    type: "slack",
    capabilities: SLACK_CAPABILITIES,
    credentialFields: [
      { name: "botToken", label: "Bot token", secret: true, required: true },
      { name: "signingSecret", label: "Signing secret", secret: true, required: true },
    ],
    verifyWebhook(req, c) {
      const ts = header(req.headers, "x-slack-request-timestamp");
      const sig = header(req.headers, "x-slack-signature");
      if (!c?.signingSecret || !ts || !sig || !/^\d{1,12}$/.test(ts)) return false;
      if (Math.abs(now() / 1000 - Number(ts)) > SLACK_MAX_SKEW_SECONDS) return false;
      return constantTimeEqual(sig, `v0=${hmacHex(c.signingSecret, `v0:${ts}:${req.rawBody}`)}`);
    },
    respondToPost(req) {
      const b = safeJson(req.rawBody);
      if (b?.type === "url_verification" && typeof b.challenge === "string") {
        return { status: 200, body: JSON.stringify({ challenge: b.challenge }), contentType: "application/json" };
      }
      return null;
    },
    parseInbound(req): InboundMessage[] {
      const b = safeJson(req.rawBody);
      const e = b?.event;
      if (b?.type !== "event_callback" || e?.type !== "message" || e.subtype || e.bot_id || !e.user || !e.channel) return [];
      if (e.channel_type && e.channel_type !== "im") return [];
      return [{
        channel: "slack", externalContactId: `${e.channel}:${e.user}`,
        externalMessageId: String(b.event_id ?? `${e.channel}:${e.ts}`),
        text: String(e.text ?? "").slice(0, 4000), receivedAt: e.ts ? new Date(Number(String(e.ts).split(".")[0]) * 1000) : new Date(),
      }];
    },
    async send(msg: OutboundMessage, c): Promise<SendResult> {
      if (!c?.botToken) throw new ChannelSendError("Slack credentials incomplete", "bad_credentials", false);
      const channel = msg.externalContactId?.split(":")[0];
      if (!channel) throw new ChannelSendError("No Slack channel", "invalid_destination", false);
      const text = (msg.ui ? formatForCapability(msg.ui, SLACK_CAPABILITIES).text : "") || msg.text;
      const d = await callApi(o, `${base}/chat.postMessage`, { headers: { authorization: `Bearer ${c.botToken}` }, body: { channel, text: text.slice(0, 3900) } }, "slack send");
      // Slack answers HTTP 200 with ok:false for application errors.
      if (!d?.ok) {
        const code = String(d?.error ?? "unknown");
        const bad = ["invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(code);
        throw new ChannelSendError(`slack send: ${code}`, bad ? "bad_credentials" : code === "ratelimited" ? "unavailable" : "rejected", code === "ratelimited");
      }
      return { delivered: "channel", externalMessageId: d.ts };
    },
    async checkHealth(c) {
      if (!c.botToken) return { ok: false, detail: "missing credentials" };
      try {
        const d = await callApi(o, `${base}/auth.test`, { headers: { authorization: `Bearer ${c.botToken}` }, body: {} }, "slack health");
        return d?.ok ? { ok: true, detail: `Workspace ${d.team ?? "unknown"}` } : { ok: false, detail: String(d?.error ?? "auth.test failed") };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}
