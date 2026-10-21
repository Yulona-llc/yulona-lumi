import type { JobHandlers } from "@yulona/queue";
import { createProvidersFromEnv } from "@yulona/providers";
import { createIntegrationJobHandlers } from "@yulona/integrations";

/** Outbound webhooks delivery + GDPR export/erasure jobs (see docs/api/integrations.md). */
export function buildIntegrationJobHandlers(): JobHandlers {
  return createIntegrationJobHandlers({ storage: createProvidersFromEnv().storage });
}
