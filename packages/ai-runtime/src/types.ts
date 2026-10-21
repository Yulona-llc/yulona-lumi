import type { ChannelCapability, ConversionStage, ToolManifest, WidgetUISchema } from "@yulona/shared";

export type HandoffType = "uncertainty" | "stage" | "system_failure";

export interface CustomToolConfig {
  manifest: ToolManifest;
  /** Credential used per manifest.authType (api key / bearer token). Never sent to the model. */
  secret?: string;
}

export interface AgentConfig {
  id: string;
  tenantId: string;
  name: string;
  systemPrompt: string;
  /** Optional first message; used as the widget's opening message when the widget has no welcomeMessage. */
  greeting?: string;
  /** cosine similarity floor, 0..1 */
  similarityThreshold: number;
  topK: number;
  fallbackMessage: string;
  /** reply when nothing grounded was found but the unanswered-turn limit is not reached yet */
  clarifyMessage: string;
  handoffMessage: string;
  /** a customer message containing one of these hands off immediately */
  escalationKeywords: string[];
  /** consecutive ungrounded questions before the AI hands off (1 = hand off on the first miss) */
  maxUnansweredTurns: number;
  /** customer reply that returns a waiting conversation to the AI (empty = disabled) */
  resumeKeyword: string;
  model?: string;
  /** built-in + custom tool names enabled for this agent */
  enabledTools: string[];
  /** bare manifests (as the dashboard saves them) or { manifest, secret? } */
  customTools: (CustomToolConfig | ToolManifest)[];
  /** When the lead becomes `qualified`, hand off to a human with a lead card. */
  handoffAtQualified: boolean;
}

export interface Lead {
  name?: string;
  email?: string;
  phone?: string;
  need?: string;
  budget?: string;
  timeline?: string;
  score?: number;
}

export interface LeadCard extends Lead {
  stage: ConversionStage;
  summary: string;
}

export interface HandoffRecord {
  type: HandoffType;
  reason: string;
  summary: string;
  leadCard?: LeadCard;
  /** What the customer is told. */
  customerMessage: string;
  /** an in-process tool already created the handoff row / paused the AI; persist nothing extra */
  alreadyRaised?: boolean;
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  sourceName: string;
  content: string;
  score: number;
}

export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolRun {
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  success: boolean;
  error?: string;
  latencyMs: number;
}

export interface TurnResult {
  /** UI blocks formatted for the channel */
  ui: WidgetUISchema;
  /** plain-text rendition (what non-rich channels send, and the messages.content value) */
  text: string;
  stageBefore: ConversionStage;
  stageAfter: ConversionStage;
  retrieved: RetrievedChunk[];
  guardTriggered: boolean;
  /** consecutive ungrounded turns after this one (persisted in conversation_ai_state) */
  unansweredAfter?: number;
  handoff?: HandoffRecord;
  toolRuns: ToolRun[];
  lead: Lead;
  usage: { promptTokens: number; completionTokens: number };
  /** model that actually answered, the provider profile it ran on (SaaS) and an allowed-model fallback note */
  model?: string;
  profileId?: string | null;
  modelFallback?: { requested: string; used: string };
  /** channel reply window already expired; adapter must use a template instead of free text */
  windowExpired?: boolean;
}

export interface RuntimeEvent {
  type: "message.created" | "conversation.handoff" | "conversation.stage_changed";
  tenantId: string;
  conversationId: string;
  messageId?: string;
  data?: Record<string, unknown>;
}

export type { ChannelCapability };
