import { brandAnswerSchema, hoursAnswerSchema, type Goal, type OnboardingStep, type OnboardingStepId, type StepOption } from "@yulona/shared";
import { z } from "zod";

interface BusinessType {
  value: string; label: string; description: string;
  goals: Goal[]; channels: string[]; tone: string; languages: string[];
  /** one line: who the customers are and what they typically ask */
  topics: string;
  greeting: (name: string) => string;
}

export const BUSINESS_TYPES: BusinessType[] = [
  { value: "restaurant", label: "Restaurant or cafe", description: "Menu, opening hours, reservations", goals: ["support", "bookings"], channels: ["widget", "whatsapp", "instagram"], tone: "friendly", languages: ["en"],
    topics: "menu and prices, opening hours, location, reservations and delivery", greeting: (n) => `Hi, welcome to ${n}! Ask me about our menu, opening hours or book a table.` },
  { value: "clinic", label: "Clinic or health service", description: "Appointments, services, opening hours", goals: ["bookings", "support"], channels: ["widget", "whatsapp"], tone: "professional", languages: ["en"],
    topics: "services, appointments, opening hours, location and what to bring. Never give medical advice and hand over to a person for emergencies", greeting: (n) => `Hello, and welcome to ${n}. How can I help you today?` },
  { value: "retail", label: "Shop or online store", description: "Products, orders, returns", goals: ["support", "leads"], channels: ["widget", "whatsapp", "facebook"], tone: "friendly", languages: ["en"],
    topics: "products, prices, orders, delivery and returns", greeting: (n) => `Hi! Welcome to ${n}. Looking for something? I can help.` },
  { value: "real_estate", label: "Real estate", description: "Listings, viewings, enquiries", goals: ["leads", "bookings"], channels: ["widget", "whatsapp", "facebook"], tone: "professional", languages: ["en"],
    topics: "listings, prices, viewings and how to get in touch with an agent", greeting: (n) => `Welcome to ${n}. Tell me what kind of property you are looking for.` },
  { value: "education", label: "School or training", description: "Courses, fees, enrolment", goals: ["leads", "support"], channels: ["widget", "telegram", "whatsapp"], tone: "friendly", languages: ["en"],
    topics: "courses, fees, schedules and enrolment steps", greeting: (n) => `Hi, welcome to ${n}! Ask me about our courses, fees or how to enrol.` },
  { value: "hotel", label: "Hotel or travel", description: "Rooms, rates, bookings", goals: ["bookings", "support"], channels: ["widget", "whatsapp", "facebook"], tone: "professional", languages: ["en"],
    topics: "rooms, rates, availability, check-in times and local information", greeting: (n) => `Welcome to ${n}. How can I help with your stay?` },
  { value: "services", label: "Professional services", description: "Consulting, agencies, freelancers", goals: ["leads", "support"], channels: ["widget", "whatsapp"], tone: "professional", languages: ["en"],
    topics: "services, pricing, how projects work and how to start", greeting: (n) => `Hello, welcome to ${n}. What can we help you with?` },
  { value: "other", label: "Something else", description: "Tell Lumi about it in the next steps", goals: ["support"], channels: ["widget"], tone: "friendly", languages: ["en"],
    topics: "the business, its products or services and how to contact it", greeting: (n) => `Hi, welcome to ${n}! How can I help?` },
];
export const businessType = (v: unknown) => BUSINESS_TYPES.find((b) => b.value === v) ?? BUSINESS_TYPES[BUSINESS_TYPES.length - 1]!;

export const GOAL_OPTIONS: StepOption[] = [
  { value: "support", label: "Answer customer questions", description: "Instant answers, with a handover to your team when needed" },
  { value: "leads", label: "Capture leads", description: "Collect contact details and qualify interested customers" },
  { value: "bookings", label: "Take bookings", description: "Let customers book appointments or visits" },
  { value: "other", label: "Something else", description: "You can tell Ask Lumi later" },
];
export const CHANNEL_OPTIONS: StepOption[] = [
  { value: "widget", label: "Website chat" }, { value: "whatsapp", label: "WhatsApp" }, { value: "facebook", label: "Messenger" },
  { value: "instagram", label: "Instagram" }, { value: "telegram", label: "Telegram" }, { value: "slack", label: "Slack" },
];
export const TONE_OPTIONS: StepOption[] = [
  { value: "friendly", label: "Friendly", description: "Warm and approachable" },
  { value: "professional", label: "Professional", description: "Polite and precise" },
  { value: "concise", label: "Short and direct", description: "Brief answers, no small talk" },
];
export const LANGUAGE_OPTIONS: StepOption[] = [
  { value: "en", label: "English" }, { value: "am", label: "Amharic" }, { value: "ar", label: "Arabic" }, { value: "fr", label: "French" },
  { value: "es", label: "Spanish" }, { value: "pt", label: "Portuguese" }, { value: "sw", label: "Swahili" },
];
export const HANDOFF_OPTIONS: StepOption[] = [
  { value: "when_unsure", label: "When the AI is not sure", description: "It hands over after it cannot answer" },
  { value: "always_offer", label: "Always offer a person", description: "Customers can ask for a teammate at any time and leads are handed over" },
  { value: "business_hours", label: "Only in business hours", description: "Outside your hours it takes a message instead" },
];
export const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(LANGUAGE_OPTIONS.map((o) => [o.value, o.label]));

const mark = (opts: StepOption[], suggested: string[]): StepOption[] => opts.map((o) => (suggested.includes(o.value) ? { ...o, suggested: true } : o));

/** The typed step schema for the wizard; options and suggestions depend on the answers given so far. */
export function buildSteps(a: Record<string, unknown>): OnboardingStep[] {
  const bt = businessType(a.businessType);
  const hasType = typeof a.businessType === "string";
  return [
    { id: "businessType", title: "What kind of business is it?", help: "Lumi uses this to pick sensible defaults you can change later.", component: "choice_cards", required: true, skippable: false,
      options: BUSINESS_TYPES.map((b) => ({ value: b.value, label: b.label, description: b.description })) },
    { id: "businessName", title: "What is your business called?", help: "Customers see this name in the chat.", component: "text", required: true, skippable: false, maxLength: 100, placeholder: "Sunrise Dental" },
    { id: "goals", title: "What do you want Lumi to help with?", help: "Choose all that apply. Your Overview shows what matters for these goals.", component: "multi_chips", required: true, skippable: false, multi: true, maxSelect: 4,
      options: mark(GOAL_OPTIONS, hasType ? bt.goals : []) },
    { id: "channels", title: "Where do your customers talk to you?", help: "Website chat is set up now. You connect the others later under Channels.", component: "multi_chips", required: false, skippable: true, multi: true, maxSelect: 6,
      options: mark(CHANNEL_OPTIONS, hasType ? bt.channels : ["widget"]) },
    { id: "tone", title: "How should Lumi sound?", component: "choice_cards", required: false, skippable: true, options: mark(TONE_OPTIONS, hasType ? [bt.tone] : []) },
    { id: "languages", title: "Which languages do your customers write in?", help: "Lumi answers in the language the customer uses.", component: "multi_chips", required: false, skippable: true, multi: true, maxSelect: 7,
      options: mark(LANGUAGE_OPTIONS, hasType ? bt.languages : ["en"]) },
    { id: "hours", title: "When is your team available?", help: "Used for handovers to your team and out-of-hours replies.", component: "hours", required: false, skippable: true },
    { id: "website", title: "Do you have a website Lumi can learn from?", help: "Lumi reads up to 25 pages, following links up to 3 levels deep. You can add more later under Knowledge.", component: "url", required: false, skippable: true, maxLength: 2048, placeholder: "https://example.com" },
    { id: "brand", title: "Pick your brand colour", help: "Used for the chat window on your website.", component: "brand", required: false, skippable: true },
    { id: "handoff", title: "When should customers reach a person?", component: "choice_cards", required: false, skippable: true, options: HANDOFF_OPTIONS.map((o, i) => (i === 0 ? { ...o, suggested: true } : o)) },
    { id: "preview", title: "Here is what Lumi will set up", help: "Nothing goes live until you publish. You can change everything afterwards.", component: "preview", required: false, skippable: false },
  ];
}

const opt = (o: StepOption[]) => z.enum(o.map((x) => x.value) as [string, ...string[]]);
const str = (max: number) => z.string().trim().min(1).max(max);
const urlAnswer = z.union([z.literal(""), z.string().trim().max(2048).pipe(z.url({ protocol: /^https?$/ }))]);

/** Validate one answer against its step; returns the normalised value. Throws ZodError. */
export function parseAnswer(id: OnboardingStepId, value: unknown): unknown {
  switch (id) {
    case "businessType": return opt(BUSINESS_TYPES.map((b) => ({ value: b.value, label: b.label }))).parse(value);
    case "businessName": return str(100).parse(value);
    case "goals": return z.array(opt(GOAL_OPTIONS)).min(1).max(4).refine((g) => new Set(g).size === g.length, "Duplicate choice").parse(value);
    case "channels": return z.array(opt(CHANNEL_OPTIONS)).max(6).refine((g) => new Set(g).size === g.length, "Duplicate choice").parse(value);
    case "tone": return opt(TONE_OPTIONS).parse(value);
    case "languages": return z.array(opt(LANGUAGE_OPTIONS)).min(1).max(7).refine((g) => new Set(g).size === g.length, "Duplicate choice").parse(value);
    case "hours": return hoursAnswerSchema.parse(value);
    case "website": return urlAnswer.parse(value);
    case "brand": return brandAnswerSchema.parse(value);
    case "handoff": return opt(HANDOFF_OPTIONS).parse(value);
    case "preview": throw new z.ZodError([{ code: "custom", path: [], message: "This step has no answer" }]);
  }
}
