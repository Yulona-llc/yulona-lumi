import { z } from "zod";

/** Strict bodies for the agent builder endpoints (see docs/api/agent-builder.md). */
export const sessionMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000).optional(),
  choice: z.string().trim().min(1).max(200).optional(),
}).refine((b) => (b.text === undefined) !== (b.choice === undefined), { message: "Send exactly one of text or choice" });

export const createSessionSchema = z.strictObject({});
export const createAgentSchema = z.strictObject({});

export const MAX_USER_MESSAGES = 60;
export const MAX_SESSION_TOKENS = 150_000;
export const MAX_TOOL_ROUNDS = 6;
export const MAX_KNOWLEDGE_PER_SESSION = 3;

export interface Draft {
  name?: string;
  description?: string;
  config: Record<string, unknown>;
  knowledge: { id: string; name: string; type: "url" | "text" }[];
  ready: boolean;
}
export const emptyDraft = (): Draft => ({ config: {}, knowledge: [], ready: false });
