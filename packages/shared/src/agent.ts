import { z } from "zod";
import { toolManifestSchema } from "./tool-manifest";

export const BUILTIN_TOOLS = ["qualify_lead", "collect_contact", "escalate_to_human"] as const;

/** Agent configuration (stored in agents.config / agent_versions.config). All keys optional with defaults. */
export const agentConfigSchema = z.strictObject({
  systemPrompt: z.string().max(8000).default("You are a helpful assistant for this business. Answer only from the provided knowledge."),
  /** @deprecated ignored: knowledge is read as skills, not matched by vector similarity. Kept so stored configs still validate. */
  similarityThreshold: z.number().min(0).max(1).default(0.15),
  /** @deprecated ignored (see similarityThreshold). */
  topK: z.number().int().min(1).max(20).default(5),
  fallbackMessage: z.string().max(1000).default("I'm not sure about that. Let me connect you with a teammate who can help."),
  /** Used when the AI cannot ground an answer but has not yet reached `maxUnansweredTurns`. */
  clarifyMessage: z.string().max(1000).default("I couldn't find that in the information I have. Could you rephrase it or share a bit more detail? If you'd rather talk to a person, just say so."),
  /** Sent to the customer when the AI hands the conversation to a person (before the resume hint). */
  handoffMessage: z.string().max(1000).default("Thanks! I'm handing you over to a teammate who will be with you shortly."),
  /** Hand off to a person (with a lead card) as soon as the lead is qualified. */
  handoffAtQualified: z.boolean().default(false),
  greeting: z.string().max(1000).optional(),
  model: z.string().max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  enabledTools: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(50).default(["qualify_lead", "collect_contact", "escalate_to_human"]),
  customTools: z.array(toolManifestSchema).max(20).default([]),
  escalationRules: z.strictObject({
    keywords: z.array(z.string().max(100)).max(50).default([]),
    maxUnansweredTurns: z.number().int().min(1).max(20).default(3),
    /** While waiting for a person, the customer can reply with this word to go back to the AI. Empty disables it. */
    resumeKeyword: z.string().max(40).default("AI"),
  }).default({ keywords: [], maxUnansweredTurns: 3, resumeKeyword: "AI" }),
});
export type AgentConfig = z.output<typeof agentConfigSchema>;
export type AgentConfigInput = z.input<typeof agentConfigSchema>;
