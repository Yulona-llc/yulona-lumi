import { withTenant, type Db } from "@yulona/db";
import { canTransition, WIDGET_UI_SCHEMA_VERSION, type ChannelCapability, type ConversionStage } from "@yulona/shared";
import { loadAgent } from "./agent-loader";
import { buildHandoffNotice, isResumeKeyword } from "./intent";
import {
  hasReplyTo, insertAiMessage, lastCustomerMessageAt, loadConversation, loadHistory, loadMessage, setPendingHuman, updateContact,
} from "./conversation-store";
import { messageBlock } from "./format";
import type { AiPorts } from "./ports";
import { createKnowledgePort } from "./knowledge";
import type { Resolver } from "./ssrf";
import { getOrCreateState, mergeLead, returnConversationToAi, transitionStage } from "./stage";
import { runTurn, type TurnOutcome } from "./turn";
import type { ExternalToolProvider } from "./tools";
import type { RuntimeEvent } from "./types";
import { addUsage, creditsRemaining } from "./usage";

/** Capability used when the channel adapter registry is not wired in (widget-like). */
export const WIDGET_CAPABILITY: ChannelCapability = {
  text: true, richCards: true, forms: true, fileUpload: true, typingIndicator: true, interactiveButtons: true, messageWindow: null,
};

export interface RuntimeDeps {
  db: Db;
  ports: AiPorts;
  /** channel -> capability (supplied by `packages/channels`); defaults to widget capabilities */
  getCapability?: (channel: string) => ChannelCapability;
  /** realtime hook (conversations agent publishes WS/SSE events from here) */
  onEvent?: (e: RuntimeEvent) => void | Promise<void>;
  /** in-process tools (e.g. calendar tools from @yulona/ops); agents opt in via `enabledTools` */
  externalTools?: ExternalToolProvider;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
  /** resolves tenant tool connections (decrypts server-side) for manifest-v2 custom tools */
  connections?: import("./http-tool").ConnectionResolver;
  /**
   * SaaS credit enforcement. `enabled: false` (self-hosted) records usage but never charges or gates.
   * Omitted => no gate (usage is still charged in SaaS mode through DEPLOYMENT_MODE).
   */
  credits?: { enabled: boolean; exhaustedMessage?: string };
}

export const DEFAULT_CREDITS_EXHAUSTED_MESSAGE = "Our assistant is temporarily unavailable. A member of our team will get back to you shortly.";

export interface InboundRef {
  tenantId: string;
  conversationId: string;
  messageId: string;
}

export type InboundResult =
  | { status: "replied" | "handoff"; messageId: string; outcome: TurnOutcome }
  | { status: "resumed"; messageId: string }
  | { status: "skipped"; reason: "message_not_found" | "not_customer_message" | "ai_paused" | "already_replied" | "no_agent" | "conversation_not_found" };

/**
 * message -> retrieve -> prompt -> LLM -> format -> persist. Called by the `ai.respond` job.
 * Idempotent per messageId (a retried job never double-replies).
 */
export async function handleInboundMessage(deps: RuntimeDeps, ref: InboundRef): Promise<InboundResult> {
  const { db } = deps;
  const { tenantId, conversationId } = ref;

  // ---- tx 1: load everything (short; no LLM call while a transaction is open)
  const ctx = await withTenant(db, tenantId, async (tx) => {
    const conv = await loadConversation(tx, tenantId, conversationId);
    if (!conv) return { skip: "conversation_not_found" as const };
    const msg = await loadMessage(tx, tenantId, conversationId, ref.messageId);
    if (!msg) return { skip: "message_not_found" as const };
    if (msg.senderType !== "contact") return { skip: "not_customer_message" as const };
    const state = await getOrCreateState(tx, tenantId, conversationId);
    if (conv.status === "resolved") return { skip: "ai_paused" as const };
    const paused = conv.status === "pending_human" || conv.handler === "human" || state.aiPaused || state.stage === "handoff_requested";
    if (await hasReplyTo(tx, tenantId, conversationId, ref.messageId)) return { skip: "already_replied" as const };
    const agent = await loadAgent(tx, tenantId, conv.agentId);
    if (paused) {
      // Waiting for a person: the customer can reply with the agent's keyword to go back to the AI instead of waiting.
      if (!agent || !isResumeKeyword(msg.content, agent.resumeKeyword)) return { skip: "ai_paused" as const };
      const [open] = await tx<{ id: string }[]>`
        SELECT h.id FROM handoffs h
        WHERE h.tenant_id = ${tenantId} AND h.conversation_id = ${conversationId} AND h.resolved_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = h.tenant_id AND m.conversation_id = h.conversation_id
                          AND m.sender_type = 'human' AND m.created_at > h.created_at)
        LIMIT 1`;
      if (!open) return { skip: "ai_paused" as const }; // a person is already talking to the customer: do not take over
      return { resume: true as const, agent };
    }
    if (!agent) return { skip: "no_agent" as const };
    const history = await loadHistory(tx, tenantId, conversationId, msg.createdAt);
    const lastAt = await lastCustomerMessageAt(tx, tenantId, conversationId);
    let creditsGated = false;
    if (deps.credits?.enabled) {
      const rem = await creditsRemaining(tx, tenantId);
      creditsGated = rem !== null && rem <= 0;
    }
    // Handoff notice: tell the customer how to carry on with the AI, and that the team is offline when it is.
    const [hrs] = await tx<{ closed: boolean; mode: string | null }[]>`
      SELECT NOT ops_in_business_hours(${tenantId}::uuid) AS closed,
             (SELECT out_of_hours_mode FROM ops_settings WHERE tenant_id = ${tenantId}) AS mode`;
    const handoffNotice = buildHandoffNotice({ keyword: agent.resumeKeyword, outOfHours: !!hrs?.closed, offlineNoticeSent: !!hrs?.closed && hrs.mode === "message" });
    return { conv, msg, state, agent, history, lastAt, handoffNotice, creditsGated };
  });
  if ("skip" in ctx) return { status: "skipped", reason: ctx.skip as never };
  if ("resume" in ctx) return resumeFromKeyword(deps, ref, ctx.agent.name);
  const { conv, msg, state, agent, history, lastAt, handoffNotice, creditsGated } = ctx;

  const uiEventRaw = msg.metadata?.uiEvent as { type?: string; values?: Record<string, unknown> } | undefined;
  const outcome = await runTurn(deps.ports, {
    agent,
    capability: (deps.getCapability ?? (() => WIDGET_CAPABILITY))(conv.channel),
    stage: state.stage,
    lead: state.lead,
    history,
    userText: msg.content,
    external: deps.externalTools,
    conversationId,
    uiEvent: uiEventRaw?.type === "form" && uiEventRaw.values ? { type: "form", values: uiEventRaw.values } : undefined,
    lastCustomerMessageAt: lastAt,
    unansweredTurns: state.unansweredTurns,
    handoffNotice,
    creditsExhausted: creditsGated ? { message: deps.credits?.exhaustedMessage || DEFAULT_CREDITS_EXHAUSTED_MESSAGE } : undefined,
    resolver: deps.resolver,
    fetchImpl: deps.fetchImpl,
    connections: deps.connections,
    knowledge: createKnowledgePort(db, tenantId, agent.id),
  });

  // ---- tx 2: persist atomically
  const persisted = await withTenant(db, tenantId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${conversationId}, 0))`;
    if (await hasReplyTo(tx, tenantId, conversationId, ref.messageId)) return null;

    for (const r of outcome.toolRuns) {
      await tx`
        INSERT INTO tool_executions (tenant_id, conversation_id, tool_name, input, output, success, error, latency_ms)
        VALUES (${tenantId}, ${conversationId}, ${r.name}, ${JSON.stringify(r.input)}::text::jsonb,
                ${r.output === undefined ? null : JSON.stringify(r.output)}::text::jsonb, ${r.success}, ${r.error ?? null}, ${r.latencyMs})`;
    }
    if (Object.keys(outcome.leadPatch).length) {
      await mergeLead(tx, tenantId, conversationId, outcome.leadPatch);
      if (conv.contactId) await updateContact(tx, tenantId, conv.contactId, outcome.leadPatch);
    }
    await tx`UPDATE conversation_ai_state SET unanswered_turns = ${outcome.unansweredAfter ?? 0}, updated_at = now()
             WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
    const reason = outcome.handoff ? `handoff:${outcome.handoff.type}` : outcome.leadPatch.need ? "lead_qualified" : "ai_turn";
    // External tools may have advanced the stage meanwhile (e.g. booking): only apply legal hops from the real current stage.
    let cur = (await getOrCreateState(tx, tenantId, conversationId)).stage;
    for (const s of outcome.stagePlan) {
      if (canTransition(cur, s)) cur = await transitionStage(tx, tenantId, conversationId, s, reason);
    }

    if (outcome.handoff && !outcome.handoff.alreadyRaised) {
      const h = outcome.handoff;
      await tx`
        INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary, lead_card, context)
        VALUES (${tenantId}, ${conversationId}, ${h.type}, ${h.reason}, ${h.summary},
                ${h.leadCard ? JSON.stringify(h.leadCard) : null}::text::jsonb,
                ${JSON.stringify({ messageId: ref.messageId, retrieved: outcome.retrieved.map((c) => ({ id: c.id, score: c.score })), toolRuns: outcome.toolRuns.map((r) => ({ name: r.name, success: r.success, error: r.error })) })}::text::jsonb)`;
      await tx`UPDATE conversation_ai_state SET last_handoff_type = ${h.type}, ai_paused = true WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}`;
      await setPendingHuman(tx, tenantId, conversationId);
    }
    const messageId = await insertAiMessage(tx, tenantId, conversationId, {
      text: outcome.text,
      ui: outcome.ui,
      metadata: {
        inReplyTo: ref.messageId,
        agentId: agent.id,
        stage: outcome.stageAfter,
        guardTriggered: outcome.guardTriggered,
        sources: outcome.retrieved.map((c) => ({ sourceId: c.sourceId, name: c.sourceName, score: Number(c.score.toFixed(3)) })),
        handoff: outcome.handoff ? { type: outcome.handoff.type, reason: outcome.handoff.reason } : undefined,
        windowExpired: outcome.windowExpired,
      },
    });
    await addUsage(tx, tenantId, {
      ...outcome.usage, requests: outcome.usage.promptTokens > 0 ? 1 : 0, agentId: agent.id, conversationId, source: "turn",
      model: outcome.model ?? agent.model, profileId: outcome.profileId, charge: deps.credits?.enabled,
    });
    return messageId;
  });
  if (persisted === null) return { status: "skipped", reason: "already_replied" };

  const base = { tenantId, conversationId };
  try {
    await deps.onEvent?.({ ...base, type: "message.created", messageId: persisted });
    if (outcome.stageAfter !== outcome.stageBefore) {
      await deps.onEvent?.({ ...base, type: "conversation.stage_changed", data: { from: outcome.stageBefore, to: outcome.stageAfter as ConversionStage } });
    }
    if (outcome.handoff) await deps.onEvent?.({ ...base, type: "conversation.handoff", data: { type: outcome.handoff.type, reason: outcome.handoff.reason } });
  } catch {
    // realtime is best-effort; the message is already durable
  }
  return { status: outcome.handoff ? "handoff" : "replied", messageId: persisted, outcome };
}

/**
 * The customer answered a handoff notice with the resume keyword: give the conversation back to the AI, close the
 * open handoff(s) so the Needs Attention queue clears, and welcome them back. Idempotent per messageId.
 */
async function resumeFromKeyword(deps: RuntimeDeps, ref: InboundRef, agentName: string): Promise<InboundResult> {
  const { tenantId, conversationId } = ref;
  const welcome = `Welcome back! I'm ${agentName}, your AI assistant. What can I help you with?`;
  const ids = await withTenant(deps.db, tenantId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${conversationId}, 0))`;
    if (await hasReplyTo(tx, tenantId, conversationId, ref.messageId)) return null;
    await tx`UPDATE conversations SET status = 'open', handler = 'ai', assigned_user_id = NULL, updated_at = now()
             WHERE tenant_id = ${tenantId} AND id = ${conversationId}`;
    await returnConversationToAi(tx, tenantId, conversationId);
    await tx`UPDATE handoffs SET resolved_at = now(), resolution_note = 'customer resumed the AI'
             WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId} AND resolved_at IS NULL`;
    const note = await insertAiMessage(tx, tenantId, conversationId, {
      text: "Customer chose to continue with the AI assistant", ui: { version: WIDGET_UI_SCHEMA_VERSION, components: [] }, senderType: "system",
      metadata: { event: "customer_resumed_ai", inReplyTo: ref.messageId },
    });
    const reply = await insertAiMessage(tx, tenantId, conversationId, {
      text: welcome, ui: { version: WIDGET_UI_SCHEMA_VERSION, components: [messageBlock(welcome)] },
      metadata: { inReplyTo: ref.messageId, event: "resumed_ai" },
    });
    return { note, reply };
  });
  if (!ids) return { status: "skipped", reason: "already_replied" };
  try {
    await deps.onEvent?.({ tenantId, conversationId, type: "message.created", messageId: ids.reply });
  } catch {
    // best-effort realtime
  }
  return { status: "resumed", messageId: ids.reply };
}
