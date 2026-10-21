import { req, send, qs } from "../integrations-ui/http";

export interface LimitRow { metric: string; limit: number | null; used: number; warning: boolean }
export interface BillingInfo {
  provider: "stripe" | "stub"; plan: { key: string; name: string };
  state: "ok" | "warning" | "grace" | "restricted" | "canceled";
  subscription: { status: "none" | "active" | "trialing" | "past_due" | "canceled"; currentPeriodEnd: string | null; graceUntil: string | null; cancelAtPeriodEnd: boolean };
  limits: LimitRow[]; checkoutPlans: string[];
}
export interface Usage { limits: LimitRow[]; series: Array<{ day: string; metric: string; value: number }> }

export const billingApi = {
  info: () => req<BillingInfo>("/billing"),
  usage: (days = 30) => req<Usage>(`/usage${qs({ days })}`),
  checkout: (plan: string) => req<{ url: string }>("/billing/checkout", send("POST", { plan })),
  portal: () => req<{ url: string }>("/billing/portal", send("POST", {})),
  cancel: () => req<{ ok: true }>("/billing/cancel", send("POST", {})),
};
export const METRIC_LABEL: Record<string, string> = {
  seats: "Team seats", agents: "AI agents", widgets: "Widgets", api_keys: "API keys",
  monthly_conversations: "Conversations this month", storage_mb: "Knowledge storage (MB)", llm_tokens_monthly: "AI tokens this month", llm_credits_monthly: "AI credits this month",
};
