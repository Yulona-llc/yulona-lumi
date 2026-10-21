import type { Db } from "@yulona/db";
import type { JobHandlers } from "@yulona/queue";
import { createConnectionResolver, createJobHandlers, createLlmResolver, portsFromResolver } from "@yulona/ai-runtime";
import { buildChannelJobHandlers } from "./channels";
import { buildIntegrationJobHandlers } from "./integrations";
import { buildCalendarExternalTools } from "./ops-tools";

/**
 * Job registry. Each wave adds one entry here. Handlers are (payload, ctx) => Promise<void>.
 * Realtime events from the AI runtime reach sockets through Postgres NOTIFY triggers on `messages`,
 * so no `onEvent` wiring is needed.
 */
export function buildJobHandlers(db: Db): JobHandlers {
  // SaaS: platform LLM profile (30 s cache) with env fallback + credit metering/gate; self-hosted: env provider, usage recorded, never charged.
  const mode = process.env.DEPLOYMENT_MODE === "selfhosted" ? "selfhosted" : "saas";
  const llm = createLlmResolver({ db, mode, encryptionKey: process.env.ENCRYPTION_KEY });
  const credits = { enabled: mode === "saas", exhaustedMessage: process.env.CREDITS_EXHAUSTED_MESSAGE || undefined };
  const ai = createJobHandlers({ db, ports: portsFromResolver(llm), credits, externalTools: buildCalendarExternalTools(db), connections: createConnectionResolver({ db, encryptionKey: process.env.ENCRYPTION_KEY }) });
  return {
    ...(Object.fromEntries(Object.entries(ai).map(([name, h]) => [name, (payload: unknown) => h(payload)])) as JobHandlers),
    ...buildChannelJobHandlers(db),
    ...buildIntegrationJobHandlers(),
  };
}
