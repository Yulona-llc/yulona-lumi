import type { ChannelCapability } from "@yulona/shared";
import type { ChannelAdapter } from "./types";

export const WIDGET_CAPABILITIES: ChannelCapability = {
  text: true,
  richCards: true,
  forms: true,
  fileUpload: false,
  typingIndicator: true,
  interactiveButtons: true,
  messageWindow: null,
};

/**
 * The website widget has no webhooks: inbound arrives through the public widget API and outbound is
 * delivered over the realtime layer (messages are persisted; DB triggers publish them).
 */
export const widgetAdapter: ChannelAdapter = {
  type: "widget",
  capabilities: WIDGET_CAPABILITIES,
  verifyWebhook: () => false,
  parseInbound: () => [],
  send: async () => ({ delivered: "realtime" }),
};
