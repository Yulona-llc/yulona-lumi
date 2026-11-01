import type { OnboardingState, WorkspaceProfile, Goal } from "@yulona/shared";
import { req, send } from "../integrations-ui/http";

/** Endpoints of docs/api/copilot.md (onboarding and workspace profile). */
export const onboardingApi = {
  state: () => req<OnboardingState>("/onboarding"),
  answer: (stepId: string, value: unknown) => req<OnboardingState>("/onboarding/answers", send("PUT", { stepId, value })),
  skip: () => req<OnboardingState>("/onboarding/skip", send("POST", {})),
  finish: () => req<import("@yulona/shared").BundleResult>("/onboarding/finish", send("POST", {})),
  profile: () => req<WorkspaceProfile>("/workspace/profile"),
  setGoals: (goals: Goal[]) => req<WorkspaceProfile>("/workspace/profile", send("PUT", { goals })),
};

export const GOAL_LABEL: Record<Goal, string> = { support: "Answer customer questions", leads: "Capture leads", bookings: "Take bookings", other: "Something else" };
