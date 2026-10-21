import { z } from "zod";
import { request as rawRequest, type Opts } from "../../api/client";
import type { AgentConfig } from "@yulona/shared";

export interface BuilderDraft {
  name?: string;
  description?: string;
  config: Partial<AgentConfig>;
  knowledge: { id: string; name: string; type: "url" | "text" }[];
  ready: boolean;
}
export interface BuilderMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  payload: { ask?: { question: string; options: string[] }; ready?: boolean; choice?: boolean } | null;
  createdAt: string;
}
export interface BuilderSession {
  id: string;
  status: "open" | "created" | "abandoned";
  agentId: string | null;
  draft: BuilderDraft;
  limits: { maxUserMessages: number; userMessages: number };
  messages: BuilderMessage[];
}
export interface CreatedAgent { agentId: string; name: string; status: string; sandboxHint: { path: string; tab: string; message: string } }

const request = <T,>(path: string, o: Opts<T> = {}) => rawRequest<T>(path, { ...o, schema: z.any() as z.ZodType<T> });
const post = (body: unknown) => ({ auth: true, method: "POST", body }) as const;

/** Endpoints of docs/api/agent-builder.md. */
export const builder = {
  start: () => request<BuilderSession>("/agent-builder/sessions", post({})),
  session: (id: string) => request<BuilderSession>(`/agent-builder/sessions/${id}`, { auth: true }),
  send: (id: string, b: { text: string } | { choice: string }) => request<{ assistant: BuilderMessage; draft: BuilderDraft; ready: boolean }>(`/agent-builder/sessions/${id}/messages`, post(b)),
  create: (id: string) => request<CreatedAgent>(`/agent-builder/sessions/${id}/create`, post({})),
};
