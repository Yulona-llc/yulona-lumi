import { z } from "zod";
import { handleInboundMessage, type RuntimeDeps } from "./runtime";
import { ingestSource, type IngestDeps } from "./ingest";

export const AI_RESPOND_JOB = "ai.respond";
export const KNOWLEDGE_INGEST_JOB = "knowledge.ingest";
export const KNOWLEDGE_CRAWL_JOB = "knowledge.crawl";

const uuid = z.string().uuid();
export const aiRespondPayload = z.strictObject({ tenantId: uuid, conversationId: uuid, messageId: uuid });
export const ingestPayload = z.strictObject({ tenantId: uuid, sourceId: uuid });
export type AiRespondPayload = z.infer<typeof aiRespondPayload>;

export type JobHandler = (payload: unknown) => Promise<void>;

/**
 * Worker job handlers keyed by job name. Register in apps/worker/src/jobs/index.ts:
 *   Object.assign(handlers, createJobHandlers({ db, ports, onEvent }))
 * Handlers throw on retryable failures (queue retries with backoff) and return normally otherwise.
 */
export function createJobHandlers(deps: RuntimeDeps & IngestDeps): Record<string, JobHandler> {
  return {
    [AI_RESPOND_JOB]: async (payload) => {
      await handleInboundMessage(deps, aiRespondPayload.parse(payload));
    },
    [KNOWLEDGE_INGEST_JOB]: async (payload) => {
      await ingestSource(deps, ingestPayload.parse(payload));
    },
    // re-crawl of a URL source: same pipeline (the source row is re-queued to `pending` first)
    [KNOWLEDGE_CRAWL_JOB]: async (payload) => {
      await ingestSource(deps, ingestPayload.parse(payload));
    },
  };
}
