import { agentConfigSchema, type AgentConfigInput, type Goal } from "@yulona/shared";
import { LANGUAGE_NAMES, businessType } from "./onboarding-steps";

export interface Answers {
  businessType?: string; businessName?: string; goals?: Goal[]; channels?: string[]; tone?: string; languages?: string[];
  hours?: { mode: "always" } | { mode: "custom"; timezone: string; days: { weekday: number; start: string; end: string }[] };
  website?: string; brand?: { color: string; logoUrl?: string }; handoff?: string;
}

const TONE_TEXT: Record<string, string> = {
  friendly: "Be warm, friendly and approachable. Use simple words and short sentences.",
  professional: "Be polite, precise and professional. Keep a respectful tone.",
  concise: "Be brief and direct. Give the answer first, without small talk.",
};

/** Server template for the agent, no model involved. Deterministic so the fallback path is predictable. */
export function agentTemplate(a: Answers) {
  const bt = businessType(a.businessType);
  const name = a.businessName ?? "this business";
  const goals = a.goals ?? ["support"];
  const langs = (a.languages?.length ? a.languages : ["en"]).map((l) => LANGUAGE_NAMES[l] ?? l);
  const lines = [
    `You are the virtual assistant of ${name}. You chat with its customers about ${bt.topics}.`,
    TONE_TEXT[a.tone ?? bt.tone] ?? TONE_TEXT.friendly!,
    `Answer only from the knowledge you have been given and never invent prices, hours or policies. If you do not know, say so and offer to connect the customer with a person.`,
    `Reply in the language the customer writes in. Customers of ${name} mostly use ${langs.join(", ")}.`,
  ];
  if (goals.includes("leads")) lines.push("When a customer shows interest, politely ask for their name and a way to contact them, then record it.");
  if (goals.includes("bookings")) lines.push("When a customer wants to book, collect the date, time and their contact details and use the booking tools.");
  if (a.handoff === "always_offer") lines.push("Remind customers they can ask for a person at any time.");
  const tools = ["collect_contact", "escalate_to_human"];
  if (goals.includes("leads")) tools.unshift("qualify_lead");
  if (goals.includes("bookings")) tools.push("check_availability", "book_appointment");
  const config: AgentConfigInput = {
    systemPrompt: lines.join("\n"),
    greeting: bt.greeting(name),
    enabledTools: tools,
    handoffAtQualified: a.handoff === "always_offer" && goals.includes("leads"),
    escalationRules: { keywords: ["human", "person", "agent", "complaint"], maxUnansweredTurns: a.handoff === "when_unsure" || !a.handoff ? 2 : 3, resumeKeyword: "AI" },
  };
  return { name: `${name} assistant`.slice(0, 100), description: `Starter agent created by Lumi onboarding for ${bt.label.toLowerCase()}.`, config: agentConfigSchema.parse(config) };
}

export function widgetTemplate(a: Answers, greeting: string) {
  const name = a.businessName ?? "Chat";
  return {
    name: `${name} website chat`.slice(0, 100),
    config: {
      title: name.slice(0, 60),
      welcomeMessage: greeting.slice(0, 500),
      ...(a.brand?.color ? { primaryColor: a.brand.color } : {}),
      ...(a.brand?.logoUrl ? { avatarUrl: a.brand.logoUrl } : {}),
    },
  };
}

export function opsTemplate(a: Answers) {
  const out: { timezone?: string; businessHours?: { weekday: number; start: string; end: string }[]; outOfHours?: { mode: "ai_only" | "message" | "queue"; message?: string | null } } = {};
  if (a.hours?.mode === "custom") {
    out.timezone = a.hours.timezone;
    out.businessHours = a.hours.days.map((d) => ({ weekday: d.weekday, start: d.start, end: d.end }));
  }
  if (a.handoff === "business_hours") out.outOfHours = { mode: "message", message: "Our team is offline right now. Leave your message and we will get back to you when we open." };
  return out;
}

/** Plain-language lines for the wizard's preview step. */
export function previewLines(a: Answers): string[] {
  const bt = businessType(a.businessType);
  const l = [`A draft assistant for your ${bt.label.toLowerCase()}, ready to try (not published).`, "A website chat window with your name and colour."];
  if (a.website) l.push(`Lumi learns from ${a.website} (up to 25 pages, 3 levels deep).`);
  if (a.hours?.mode === "custom") l.push("Your business hours for handovers.");
  l.push(`Your goals: ${(a.goals ?? []).map((g) => ({ support: "answer questions", leads: "capture leads", bookings: "take bookings", other: "other" }[g])).join(", ") || "none yet"}.`);
  return l;
}
