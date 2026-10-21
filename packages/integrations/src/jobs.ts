import type { JobHandlers } from "@yulona/queue";
import type { StorageProvider } from "@yulona/providers";
import { createWebhookDeliverHandler, DELIVER_JOB, type DeliverOptions } from "./deliver";
import { createGdprEraseHandler, createGdprExportHandler, GDPR_ERASE_JOB, GDPR_EXPORT_JOB } from "./gdpr";

/** Worker job handlers for this area: `webhook.deliver`, `gdpr.export`, `gdpr.erase`. */
export function createIntegrationJobHandlers(deps: { storage: StorageProvider; deliver?: DeliverOptions; now?: () => Date }): JobHandlers {
  return {
    [DELIVER_JOB]: createWebhookDeliverHandler({ now: deps.now, ...deps.deliver }),
    [GDPR_EXPORT_JOB]: createGdprExportHandler({ storage: deps.storage, now: deps.now }),
    [GDPR_ERASE_JOB]: createGdprEraseHandler({ storage: deps.storage }),
  };
}
