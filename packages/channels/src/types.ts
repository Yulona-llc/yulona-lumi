import type { ChannelCapability, ChannelType, WidgetUISchema } from "@yulona/shared";

/** A normalized inbound customer message produced by an adapter. */
export interface InboundMessage {
  channel: ChannelType;
  /** Customer id on the channel (phone number, PSID, chat id...). Used for contact identity resolution. */
  externalContactId: string;
  externalMessageId?: string;
  text: string;
  displayName?: string;
  receivedAt: Date;
  /** Phone number in E.164 (`+...`) when the channel identifies customers by phone (WhatsApp). */
  phone?: string;
  raw?: unknown;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  /** Exact bytes received (signatures are computed over these). */
  rawBody: string;
  query?: Record<string, string | undefined>;
}

export interface OutboundMessage {
  conversationId: string;
  externalContactId?: string;
  /** Plain-text rendition (always present). */
  text: string;
  ui?: WidgetUISchema | null;
  /** Last customer message time, for messageWindow enforcement. */
  lastCustomerMessageAt?: Date | null;
}

export interface SendResult {
  /** `realtime` = delivered through Yulona's own socket layer (widget). */
  delivered: "realtime" | "channel";
  externalMessageId?: string;
  /** True when a template message was used because the reply window was closed. */
  usedTemplate?: boolean;
}

/** Decrypted channel connection credentials, supplied by the caller (never logged). */
export type ChannelCredentials = Record<string, string>;

/** Describes one credential field so the dashboard can render the connect form. */
export interface CredentialField {
  name: string;
  label: string;
  /** Secret values are masked everywhere after creation. */
  secret: boolean;
  required: boolean;
}

export interface WebhookResponse {
  status: number;
  body: string;
  contentType?: string;
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapability;
  /** Credential fields accepted when creating a connection (empty for widget). */
  readonly credentialFields?: readonly CredentialField[];
  /** GET handshake (Meta `hub.challenge`). Return null when the request is not a handshake. */
  handleVerification?(req: WebhookRequest, credentials: ChannelCredentials): WebhookResponse | null;
  /** POST requests that need a protocol reply instead of ingestion (Slack `url_verification`). Runs after signature verification. */
  respondToPost?(req: WebhookRequest): WebhookResponse | null;
  /** Cheap call that proves the stored credentials work. */
  checkHealth?(credentials: ChannelCredentials): Promise<HealthResult>;
  verifyWebhook(req: WebhookRequest, credentials?: ChannelCredentials): boolean | Promise<boolean>;
  parseInbound(req: WebhookRequest): InboundMessage[];
  send(msg: OutboundMessage, credentials?: ChannelCredentials): Promise<SendResult>;
}
