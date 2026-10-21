import type { Db } from "@yulona/db";
import type { JobHandlers } from "@yulona/queue";
import { createChannelJobHandlers, createDefaultRegistry } from "@yulona/channels";
// Dependency-free AES-256-GCM envelope helper shared with the API (same ENCRYPTION_KEY).
import { decryptCredentials } from "@yulona/crypto";

/** `channel.send`: delivers AI/human replies to WhatsApp, Messenger, Instagram, Telegram and Slack. */
export function buildChannelJobHandlers(db: Db, env: Record<string, string | undefined> = process.env): JobHandlers {
  const key = env.ENCRYPTION_KEY;
  return createChannelJobHandlers({
    db,
    registry: createDefaultRegistry(),
    decrypt: (envelope, aad) => {
      if (!key) throw new Error("ENCRYPTION_KEY is not configured");
      return decryptCredentials(key, envelope, aad);
    },
  });
}
