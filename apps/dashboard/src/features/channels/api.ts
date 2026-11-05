import { req, send } from "../integrations-ui/http";

export type ChannelKey = "whatsapp" | "facebook" | "instagram" | "telegram" | "slack";
export interface CredentialField { name: string; label: string; secret: boolean; required: boolean }
export interface AvailableChannel { channel: ChannelKey; capabilities?: Record<string, unknown>; credentialFields: CredentialField[] }
export interface Connection {
  id: string; channel: ChannelKey; name: string; externalId: string | null; agentId: string | null;
  status: "active" | "disabled" | "error"; credentialsMasked: Record<string, string>; webhookUrl: string;
  health: { checkedAt: string | null; ok: boolean | null; error: string | null } | null; createdAt: string; updatedAt: string;
}
export interface MergeSuggestion {
  id: string; reason: "same_email" | "same_phone" | "same_name"; createdAt: string;
  primary: { id: string; name: string | null; email?: string | null; phone?: string | null };
  other: { id: string; name: string | null; email?: string | null; phone?: string | null };
}

export const channelsApi = {
  available: () => req<{ items: AvailableChannel[] }>("/channels/available").then((r) => r.items),
  list: () => req<{ items: Connection[] }>("/channels/connections").then((r) => r.items),
  create: (b: { channel: ChannelKey; name: string; agentId?: string; credentials: Record<string, string> }) =>
    req<Connection & { generatedSecrets?: Record<string, string> }>("/channels/connections", send("POST", b)),
  update: (id: string, b: { name?: string; agentId?: string | null; status?: "active" | "disabled"; credentials?: Record<string, string> }) =>
    req<Connection>(`/channels/connections/${id}`, send("PATCH", b)),
  remove: (id: string) => req<unknown>(`/channels/connections/${id}`, send("DELETE")),
  registerWebhook: (id: string) => req<{ ok: boolean; detail: string | null; webhookUrl: string }>(`/channels/connections/${id}/register-webhook`, send("POST", {})),
  test: (id: string) => req<{ ok: boolean; detail: string; checkedAt: string }>(`/channels/connections/${id}/test`, send("POST", {})),
  suggestions: () => req<{ items: MergeSuggestion[] }>("/channels/merge-suggestions").then((r) => r.items),
  dismiss: (id: string) => req<unknown>(`/channels/merge-suggestions/${id}/dismiss`, send("POST", {})),
  merge: (primary: string, source: string) => req<unknown>(`/contacts/${primary}/merge`, send("POST", { sourceContactId: source })),
};

export const CHANNEL_META: Record<ChannelKey, { label: string; hint: string; color: string }> = {
  whatsapp: { label: "WhatsApp", hint: "Cloud API. Replies outside 24 hours need an approved template.", color: "#1f9d55" },
  facebook: { label: "Messenger", hint: "Facebook Page messages. 24 hour reply window.", color: "#2f5bd8" },
  instagram: { label: "Instagram", hint: "Instagram direct messages. 24 hour reply window.", color: "#b8337a" },
  telegram: { label: "Telegram", hint: "Bot API. No reply window.", color: "#2a8bc4" },
  slack: { label: "Slack", hint: "Bot token and signing secret. No reply window.", color: "#6b3fa0" },
};
