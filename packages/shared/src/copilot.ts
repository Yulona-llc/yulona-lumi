import { z } from "zod";

// ---------- workspace goals ----------
export const GOALS = ["support", "leads", "bookings", "other"] as const;
export const goalSchema = z.enum(GOALS);
export type Goal = z.infer<typeof goalSchema>;
export const goalsSchema = z.array(goalSchema).max(4).refine((g) => new Set(g).size === g.length, "Duplicate goal");
export const updateProfileSchema = z.strictObject({ goals: goalsSchema });
export const ONBOARDING_STATUSES = ["not_started", "in_progress", "completed", "skipped"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export interface WorkspaceProfile {
  name: string;
  goals: Goal[];
  onboarding: { status: OnboardingStatus; completedAt: string | null; skippedAt: string | null };
}

// ---------- onboarding step schema (rendered by a whitelisted component map in the dashboard) ----------
export const ONBOARDING_COMPONENTS = ["choice_cards", "multi_chips", "text", "url", "brand", "hours", "preview"] as const;
export type OnboardingComponent = (typeof ONBOARDING_COMPONENTS)[number];
export const ONBOARDING_STEP_IDS = ["businessType", "businessName", "goals", "channels", "tone", "languages", "hours", "website", "brand", "handoff", "preview"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];
export interface StepOption { value: string; label: string; description?: string; suggested?: boolean }
export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  help?: string;
  component: OnboardingComponent;
  required: boolean;
  skippable: boolean;
  multi?: boolean;
  maxSelect?: number;
  maxLength?: number;
  placeholder?: string;
  options?: StepOption[];
}
export interface BundleResult {
  agentId: string;
  widgetId: string;
  knowledgeSourceId: string | null;
  usedModel: boolean;
  goals: Goal[];
  nextStep: { label: string; path: string };
}
export interface OnboardingState {
  status: OnboardingStatus;
  currentStepId: OnboardingStepId;
  steps: OnboardingStep[];
  answers: Record<string, unknown>;
  progress: { done: number; total: number };
  result: BundleResult | null;
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #2563EB");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "HH:MM");
export const hoursAnswerSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("always") }),
  z.strictObject({
    mode: z.literal("custom"),
    timezone: z.string().min(1).max(64),
    days: z.array(z.strictObject({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).min(1).max(28),
  }),
]);
export const brandAnswerSchema = z.strictObject({ color: hex, logoUrl: z.url({ protocol: /^https$/ }).max(500).optional() });
export const answerBodySchema = z.strictObject({ stepId: z.enum(ONBOARDING_STEP_IDS), value: z.unknown() });

// ---------- copilot message blocks (whitelist; never HTML) ----------
export type CopilotBlock =
  | { type: "chips"; options: string[] }
  | { type: "checklist"; items: { label: string; done: boolean; path?: string }[] }
  | { type: "diff"; title: string; changes: { field: string; before: string; after: string }[] }
  | { type: "preview"; title: string; lines: string[] }
  | { type: "confirm"; token: string; title: string; summary: string; expiresAt: string }
  | { type: "link"; label: string; path: string };
export const COPILOT_BLOCK_TYPES = ["chips", "checklist", "diff", "preview", "confirm", "link"] as const;

export const copilotMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000).optional(),
  choice: z.string().trim().min(1).max(200).optional(),
}).refine((b) => (b.text === undefined) !== (b.choice === undefined), { message: "Send exactly one of text or choice" });
export const copilotTokenSchema = z.strictObject({ token: z.string().min(20).max(100) });
export interface CopilotAllowance { limitCredits: number | null; usedMicro: number; remainingMicro: number | null; resetsAt: string }
export interface CopilotStatus {
  access: "allowed" | "locked";
  reason: "requires_plan" | null;
  selfHosted: boolean;
  allowance: CopilotAllowance;
  session: { id: string; userMessages: number; maxUserMessages: number } | null;
}

// ---------- overview ----------
export interface OverviewDto {
  goals: Goal[];
  order: Goal[];
  common: {
    conversations: { last30d: number; open: number; today: number };
    credits: { remainingMicro: number | null; allowanceMicro: number | null };
    channels: { total: number; connected: number; unhealthy: number };
    setup: { items: { key: string; label: string; done: boolean; path: string }[]; doneCount: number; total: number };
  };
  support?: { aiResolvedPct: number | null; handoffs: number; medianFirstResponseSeconds: number | null; unanswered: { count: number; items: { id: string; conversationId: string | null; createdAt: string }[] } };
  leads?: { funnel: { stage: string; count: number }[]; qualified: number; hubspot: { connected: boolean; lastSyncAt: string | null; failed: number } };
  bookings?: { upcoming: number; booked30d: number; cancelled30d: number; calendar: { connected: boolean; provider: string | null } };
}
