import type { JobHandlers } from "@yulona/queue";
import { createProvidersFromEnv } from "@yulona/providers";
import { createIntegrationJobHandlers, storageOrDatabase } from "@yulona/integrations";
import type { Db } from "@yulona/db";

/** Outbound webhooks delivery + GDPR export/erasure jobs (see docs/api/integrations.md). */
export function buildIntegrationJobHandlers(db: Db): JobHandlers {
  return createIntegrationJobHandlers({ storage: storageOrDatabase(createProvidersFromEnv().storage, db) });
}
