import { withTenant, type Db } from "@yulona/db";
import type { ConversionStage } from "@yulona/shared";
import { loadAgent } from "./agent-loader";
import { WIDGET_CAPABILITY } from "./runtime";
import type { AiPorts } from "./ports";
import { createKnowledgePort } from "./knowledge";
import { runTurn } from "./turn";
import type { Lead, TurnMessage } from "./types";
import { CreditsExhaustedError, addUsage, creditsRemaining } from "./usage";

export interface SandboxInput {
  tenantId: string;
  agentId: string;
  message: string;
  stage?: ConversionStage;
  lead?: Lead;
  history?: TurnMessage[];
}

/**
 * Test console: runs the exact production turn logic in dry-run mode (nothing persisted except usage
 * counters, custom tools are not called) and exposes retrieval internals.
 */
export async function runSandbox(deps: { db: Db; ports: AiPorts; credits?: { enabled: boolean } }, i: SandboxInput) {
  const agent = await withTenant(deps.db, i.tenantId, (tx) => loadAgent(tx, i.tenantId, i.agentId, { draft: true }));
  if (!agent) return null;
  if (deps.credits?.enabled) {
    const rem = await withTenant(deps.db, i.tenantId, (tx) => creditsRemaining(tx, i.tenantId));
    if (rem !== null && rem <= 0) throw new CreditsExhaustedError(rem);
  }
  const out = await runTurn(deps.ports, {
    agent,
    capability: WIDGET_CAPABILITY,
    stage: i.stage ?? "visitor",
    lead: i.lead ?? {},
    history: i.history ?? [],
    userText: i.message,
    dryRun: true,
    knowledge: createKnowledgePort(deps.db, i.tenantId, agent.id),
  });
  await withTenant(deps.db, i.tenantId, (tx) => addUsage(tx, i.tenantId, {
    ...out.usage, requests: out.usage.promptTokens > 0 ? 1 : 0, agentId: agent.id, source: "sandbox", model: out.model ?? agent.model,
    profileId: out.profileId, charge: deps.credits?.enabled,
  }));
  return {
    answer: out.text,
    ui: out.ui,
    stageBefore: out.stageBefore,
    stageAfter: out.stageAfter,
    guardTriggered: out.guardTriggered,
    handoff: out.handoff ?? null,
    toolRuns: out.toolRuns,
    lead: out.lead,
    usage: out.usage,
    model: out.model ?? agent.model ?? null,
    /** set when the agent's model is not enabled for the platform provider and the profile default answered */
    modelNote: out.modelFallback ? `Model "${out.modelFallback.requested}" is not enabled; answered with "${out.modelFallback.used}".` : null,
    /** skill sections the agent had in front of it: pre-loaded by keyword search plus anything it opened with tools */
    retrieved: out.retrieved.map((c) => ({
      id: c.id, sourceId: c.sourceId, sourceName: c.sourceName, score: Number(c.score.toFixed(4)), content: c.content, usedForAnswer: true,
    })),
  };
}
