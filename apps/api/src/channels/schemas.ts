import { z } from "zod";
import { CHANNELS } from "@yulona/shared";

export const CONNECTABLE_CHANNELS = ["whatsapp", "facebook", "instagram", "telegram", "slack"] as const satisfies readonly (typeof CHANNELS[number])[];
export const connectableChannelSchema = z.enum(CONNECTABLE_CHANNELS);

const credentialsSchema = z.record(z.string().min(1).max(64), z.string().trim().min(1).max(2000));

export const createConnectionSchema = z.strictObject({
  channel: connectableChannelSchema,
  name: z.string().trim().min(1).max(100),
  agentId: z.string().uuid().nullable().optional(),
  credentials: credentialsSchema,
});
export const updateConnectionSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  agentId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  /** Partial: provided fields replace the stored ones, the rest are kept (rotate one secret without re-entering all). */
  credentials: credentialsSchema.optional(),
});

export const connectionSchema = z.object({
  id: z.string().uuid(),
  channel: connectableChannelSchema,
  name: z.string(),
  externalId: z.string().nullable(),
  agentId: z.string().uuid().nullable(),
  status: z.enum(["active", "disabled", "error"]),
  /** Secrets are masked (`••••1234`); non-secret identifiers are shown as stored. Plaintext secrets are never returned. */
  credentialsMasked: z.record(z.string(), z.string()),
  webhookUrl: z.string(),
  health: z.object({ checkedAt: z.string().nullable(), ok: z.boolean().nullable(), error: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConnectionDto = z.infer<typeof connectionSchema>;

export const createConnectionResponseSchema = connectionSchema.extend({
  /** Auto-generated webhook secrets (verifyToken / webhookSecret). Shown exactly once. */
  generatedSecrets: z.record(z.string(), z.string()),
});

export const healthResultSchema = z.object({ ok: z.boolean(), detail: z.string().nullable(), checkedAt: z.string() });

export const channelInfoSchema = z.object({
  channel: connectableChannelSchema,
  capabilities: z.object({
    text: z.boolean(), richCards: z.boolean(), forms: z.boolean(), fileUpload: z.boolean(),
    typingIndicator: z.boolean(), interactiveButtons: z.boolean(), messageWindow: z.number().nullable(),
  }),
  credentialFields: z.array(z.object({ name: z.string(), label: z.string(), secret: z.boolean(), required: z.boolean() })),
});

export const mergeSuggestionSchema = z.object({
  id: z.string().uuid(),
  reason: z.enum(["same_email", "same_phone", "same_name"]),
  createdAt: z.string(),
  primary: z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
  other: z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
});
