import { z } from "zod";

export const CHANNELS = ["widget", "whatsapp", "facebook", "instagram", "telegram", "slack"] as const;
export type ChannelType = (typeof CHANNELS)[number];

/** Every channel adapter declares what it can render (PLAN §3.2). */
export const channelCapabilitySchema = z.strictObject({
  text: z.boolean(),
  richCards: z.boolean(),
  forms: z.boolean(),
  fileUpload: z.boolean(),
  typingIndicator: z.boolean(),
  interactiveButtons: z.boolean(),
  /** Reply window in hours after the last customer message; null = unlimited. */
  messageWindow: z.number().positive().nullable(),
});
export type ChannelCapability = z.infer<typeof channelCapabilitySchema>;
