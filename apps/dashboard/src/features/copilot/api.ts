import type { CopilotAllowance, CopilotBlock, CopilotStatus } from "@yulona/shared";
import { req, send } from "../integrations-ui/http";

export interface CopilotMessage { id: string; role: "user" | "assistant"; content: string; payload: { blocks?: CopilotBlock[]; choice?: boolean } | null; createdAt: string }
export interface CopilotSession { id: string; status: "open" | "closed"; messages: CopilotMessage[]; limits: { maxUserMessages: number; userMessages: number } }

/** Endpoints of docs/api/copilot.md. */
export const copilotApi = {
  status: () => req<CopilotStatus>("/copilot/status"),
  start: () => req<CopilotSession>("/copilot/sessions", send("POST", {})),
  session: (id: string) => req<CopilotSession>(`/copilot/sessions/${id}`),
  send: (id: string, b: { text: string } | { choice: string }) => req<{ messages: CopilotMessage[]; assistant: CopilotMessage; allowance: CopilotAllowance }>(`/copilot/sessions/${id}/messages`, send("POST", b)),
  confirm: (id: string, token: string) => req<{ ok: boolean; message: CopilotMessage }>(`/copilot/sessions/${id}/confirm`, send("POST", { token })),
  cancel: (id: string, token: string) => req<{ ok: boolean; message: CopilotMessage }>(`/copilot/sessions/${id}/cancel`, send("POST", { token })),
};

/** Whole credits left, e.g. "148 of 150 credits left". */
export function remainingText(a: CopilotAllowance): string {
  if (a.limitCredits === null) return "No monthly limit";
  const left = Math.max(0, a.limitCredits - Math.ceil(a.usedMicro / 1_000_000));
  return `${left} of ${a.limitCredits} credits left this month`;
}
