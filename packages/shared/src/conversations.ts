import { z } from "zod";
import { CHANNELS } from "./channel";
import { widgetUISchema } from "./widget-ui";

// ---------- enums ----------
export const CONVERSATION_STATUSES = ["open", "pending_human", "resolved"] as const;
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export const conversationHandlerSchema = z.enum(["ai", "human"]);
export type ConversationHandler = z.infer<typeof conversationHandlerSchema>;
export const senderTypeSchema = z.enum(["contact", "ai", "human", "system", "note"]);
export type SenderType = z.infer<typeof senderTypeSchema>;
export const channelSchema = z.enum(CHANNELS);

// ---------- DTOs ----------
export const messageDtoSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  senderType: senderTypeSchema,
  senderUserId: z.uuid().nullable().optional(),
  senderName: z.string().nullable().optional(),
  content: z.string(),
  ui: widgetUISchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});
export type MessageDto = z.infer<typeof messageDtoSchema>;

/** What a website visitor may see of a message (no internal ids/metadata). */
export const publicMessageSchema = z.object({
  id: z.uuid(),
  senderType: z.enum(["contact", "ai", "human"]),
  senderName: z.string().nullable().optional(),
  content: z.string(),
  ui: z.unknown().nullable().optional(),
  createdAt: z.string(),
});
export type PublicMessage = z.infer<typeof publicMessageSchema>;

export const contactRefSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** ISO time when the contact was blocked for abuse; null/absent otherwise. */
  blockedAt: z.string().nullable().optional(),
});
export type ContactRef = z.infer<typeof contactRefSchema>;

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  channel: channelSchema,
  status: conversationStatusSchema,
  handler: conversationHandlerSchema,
  assignedUserId: z.uuid().nullable(),
  agentId: z.uuid().nullable(),
  widgetId: z.uuid().nullable(),
  contact: contactRefSchema,
  lastMessageAt: z.string(),
  lastMessagePreview: z.string().nullable(),
  lastCustomerMessageAt: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const contactSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  customAttributes: z.record(z.string(), z.unknown()),
  identities: z.array(z.object({ channel: channelSchema, externalId: z.string() })),
  /** Set when the contact is blocked (abuse). A blocked contact cannot start, reopen or resume a conversation. */
  blockedAt: z.string().nullable().default(null),
  blockedReason: z.string().nullable().default(null),
  /** User who blocked the contact; null when the AI/rules did. */
  blockedBy: z.uuid().nullable().default(null),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContactDto = z.infer<typeof contactSchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// ---------- dashboard inputs (all strict) ----------
const limitParam = z.coerce.number().int().min(1).max(100).default(30);
const cursorParam = z.string().max(200).optional();

export const blockContactSchema = z.strictObject({ reason: z.string().trim().max(500).optional() });

export const listConversationsQuerySchema = z.strictObject({
  status: conversationStatusSchema.optional(),
  handler: conversationHandlerSchema.optional(),
  channel: channelSchema.optional(),
  /** `me`, `unassigned` or a user id */
  assignee: z.union([z.literal("me"), z.literal("unassigned"), z.uuid()]).optional(),
  contactId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: limitParam,
  cursor: cursorParam,
});

export const listMessagesQuerySchema = z.strictObject({
  /** Return messages older than this message id. */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sendMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  /** reply = visible to the customer (sent as human); note = internal only */
  kind: z.enum(["reply", "note"]).default("reply"),
});
export type SendMessageInput = z.input<typeof sendMessageSchema>;

export const patchConversationSchema = z
  .strictObject({
    status: z.enum(["open", "resolved"]).optional(),
    assignedUserId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedUserId !== undefined, { message: "No changes supplied" });

const attrValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
/** null removes the key. */
export const customAttributesSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "Invalid attribute key"), attrValue)
  .refine((o) => Object.keys(o).length <= 50, { message: "Too many attributes" });

const optText = (max: number) => z.string().trim().max(max);
export const createContactSchema = z.strictObject({
  name: optText(200).min(1).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  phone: optText(40).min(3).optional(),
  customAttributes: customAttributesSchema.optional(),
});
export const updateContactSchema = z
  .strictObject({
    name: optText(200).min(1).nullable().optional(),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable().optional(),
    phone: optText(40).min(3).nullable().optional(),
    customAttributes: customAttributesSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes supplied" });
export const listContactsQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  limit: limitParam,
  cursor: cursorParam,
});
export const timelineQuerySchema = z.strictObject({ limit: limitParam, cursor: cursorParam });
export const mergeContactSchema = z.strictObject({ sourceContactId: z.uuid() });

// ---------- widgets ----------
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Brand colours: solid, or a two-stop linear gradient. `primaryColor` stays as the derived single colour for older clients. */
export const widgetAppearanceSchema = z.strictObject({
  mode: z.enum(["solid", "gradient"]).default("solid"),
  color: hex,
  color2: hex.optional(),
  /** Gradient direction in degrees (0 = up, 90 = right, 135 = down-right, 180 = down). */
  angle: z.number().int().min(0).max(360).default(135),
});
export type WidgetAppearance = z.infer<typeof widgetAppearanceSchema>;

export const widgetConfigSchema = z.strictObject({
  title: z.string().trim().max(60).optional(),
  subtitle: z.string().trim().max(120).optional(),
  welcomeMessage: z.string().trim().max(500).optional(),
  primaryColor: hex.optional(),
  appearance: widgetAppearanceSchema.optional(),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  position: z.enum(["right", "left"]).optional(),
  launcherLabel: z.string().trim().max(40).optional(),
  avatarUrl: z.url({ protocol: /^https$/ }).max(500).optional(),
  inputPlaceholder: z.string().trim().max(80).optional(),
  protection: z.strictObject({
    /** Hidden field that real visitors never fill; a filled value is silently dropped. */
    honeypot: z.boolean().default(true),
    turnstile: z.strictObject({
      enabled: z.boolean().default(false),
      /** Public Cloudflare Turnstile site key (the secret is write-only, see `turnstileSecret`). */
      siteKey: z.string().trim().max(100).regex(/^[A-Za-z0-9_-]*$/, "Invalid site key").default(""),
      theme: z.enum(["auto", "light", "dark"]).default("auto"),
      size: z.enum(["normal", "compact", "flexible"]).default("normal"),
      appearance: z.enum(["always", "interaction-only"]).default("always"),
      action: z.string().trim().max(32).regex(/^[A-Za-z0-9_-]*$/, "Use letters, digits, - and _").optional(),
    }).optional(),
  }).optional(),
});
export type WidgetConfig = z.infer<typeof widgetConfigSchema>;

export const prechatSchema = z.strictObject({
  enabled: z.boolean().default(false),
  intro: z.string().trim().max(300).optional(),
  fields: z
    .array(
      z.strictObject({
        name: z.enum(["name", "email", "phone"]),
        label: z.string().trim().min(1).max(80),
        required: z.boolean().default(false),
      }),
    )
    .max(3)
    .default([]),
});
export type PrechatConfig = z.infer<typeof prechatSchema>;

/** `example.com`, `*.example.com`, optional scheme and port (`https://app.example.com:8443`). */
export const allowedDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(https?:\/\/)?(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/, "Invalid domain pattern")
  .max(253);

/** Write-only Cloudflare Turnstile secret key. `null` removes it on update. */
const turnstileSecret = z.string().trim().min(8).max(200);

export const createWidgetSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  turnstileSecret: turnstileSecret.optional(),
  agentId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  config: widgetConfigSchema.optional(),
  prechat: prechatSchema.optional(),
  allowedDomains: z.array(allowedDomainSchema).max(50).optional(),
});
export const updateWidgetSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    agentId: z.uuid().nullable(),
    enabled: z.boolean(),
    config: widgetConfigSchema,
    prechat: prechatSchema,
    allowedDomains: z.array(allowedDomainSchema).max(50),
    turnstileSecret: turnstileSecret.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes supplied" });

export const widgetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  widgetKey: z.string(),
  agentId: z.uuid().nullable(),
  enabled: z.boolean(),
  config: widgetConfigSchema,
  prechat: prechatSchema,
  allowedDomains: z.array(z.string()),
  /** The Turnstile secret is never returned; this says whether one is stored. */
  hasTurnstileSecret: z.boolean(),
  /** True when an avatar image was uploaded (it wins over `config.avatarUrl`); `avatarVersion` changes with every upload. */
  hasAvatar: z.boolean().default(false),
  avatarVersion: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WidgetDto = z.infer<typeof widgetSchema>;

// ---------- public widget API ----------
export const PUBLIC_WIDGET_KEY_HEADER = "X-Widget-Key";

const visitorFields = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  phone: z.string().trim().min(3).max(40).optional(),
});
/** Honeypot (must stay empty) and Cloudflare Turnstile response token (when the widget has Turnstile enabled). */
const botFields = {
  hp: z.string().max(200).optional(),
  turnstileToken: z.string().max(2048).optional(),
};
export const startConversationSchema = z.strictObject({
  ...botFields,
  /** Stable anonymous id previously returned by this API (kept in the widget's localStorage). */
  visitorId: z.uuid().optional(),
  visitor: visitorFields.optional(),
  context: z
    .strictObject({
      pageUrl: z.string().max(500).optional(),
      referrer: z.string().max(500).optional(),
      locale: z.string().max(20).optional(),
      timezone: z.string().max(64).optional(),
    })
    .optional(),
});
export type StartConversationInput = z.input<typeof startConversationSchema>;

export const publicSendMessageSchema = z.strictObject({
  hp: botFields.hp,
  text: z.string().trim().min(1).max(4000),
  /** Idempotency key: a retried send with the same id returns the original message. */
  clientMessageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

export const publicListMessagesQuerySchema = z.strictObject({
  /** Messages strictly after this message id (catch-up after reconnect). */
  after: z.uuid().optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const uiValue = z.string().max(1000);
export const uiEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("form_submit"),
    messageId: z.uuid(),
    componentId: z.string().max(64).optional(),
    clientMessageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    values: z.record(z.string().max(64), uiValue).refine((o) => Object.keys(o).length <= 20, "Too many fields"),
  }),
  z.strictObject({
    type: z.literal("button_click"),
    messageId: z.uuid(),
    componentId: z.string().max(64).optional(),
    clientMessageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    value: z.string().max(200),
    label: z.string().max(80).optional(),
  }),
  z.strictObject({
    type: z.literal("calendar_select"),
    messageId: z.uuid(),
    componentId: z.string().max(64).optional(),
    clientMessageId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    timezone: z.string().max(64),
  }),
]);
export type UiEvent = z.infer<typeof uiEventSchema>;

export const typingSchema = z.strictObject({ typing: z.boolean() });

// ---------- realtime ----------
/** Server -> client WebSocket / SSE events. */
export type RealtimeEvent =
  | { type: "ready"; kind: "agent" | "visitor" }
  | { type: "message.created"; conversationId: string; message: MessageDto | PublicMessage }
  | { type: "conversation.updated"; conversation: ConversationSummary | { id: string; status: ConversationStatus; handler: ConversationHandler } }
  | { type: "typing"; conversationId: string; from: "contact" | "ai" | "human"; userId?: string; typing: boolean }
  | { type: "presence"; subject: "contact" | "agent"; conversationId?: string; userId?: string; online: boolean }
  | { type: "error"; code: string; message: string };

/** Client -> server WebSocket frames. The first frame MUST be `auth`. */
export const wsClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("auth"), token: z.string().max(2000) }),
  z.strictObject({ type: z.literal("typing"), conversationId: z.uuid().optional(), typing: z.boolean() }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;
