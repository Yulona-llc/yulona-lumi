export const CONVERSION_STAGES = [
  "visitor",
  "engaged",
  "qualified",
  "booking_offered",
  "booked",
  "handoff_requested",
] as const;
export type ConversionStage = (typeof CONVERSION_STAGES)[number];

/** Explicit transition table (PLAN §3.4). Any other transition is illegal. */
export const STAGE_TRANSITIONS: Readonly<Record<ConversionStage, readonly ConversionStage[]>> = {
  visitor: ["engaged", "handoff_requested"],
  engaged: ["qualified", "handoff_requested"],
  qualified: ["booking_offered", "handoff_requested"],
  booking_offered: ["booked", "qualified", "handoff_requested"],
  booked: ["handoff_requested"],
  // A human returning the conversation to the AI resumes at `engaged`.
  handoff_requested: ["engaged"],
};

export function allowedNextStages(from: ConversionStage): readonly ConversionStage[] {
  return STAGE_TRANSITIONS[from];
}

export function canTransition(from: ConversionStage, to: ConversionStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

export interface StageTransitionEvent {
  conversationId: string;
  from: ConversionStage;
  to: ConversionStage;
  reason?: string;
  at: string;
}
