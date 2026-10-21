import type { BuilderDraft, BuilderMessage } from "./api";

export interface SheetRow { key: string; label: string; value: string | null; hint: string }

const ONE = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : null);
const TOOL_LABEL: Record<string, string> = {
  qualify_lead: "Qualify leads", collect_contact: "Collect contact details", escalate_to_human: "Pass to a person",
  check_availability: "Check calendar availability", book_appointment: "Book appointments",
};

/** The rows of the live agent sheet, derived from the draft. `value: null` = not filled in yet. */
export function sheetRows(d: BuilderDraft): SheetRow[] {
  const c = d.config;
  const tools = Array.isArray(c.enabledTools) ? c.enabledTools.map((t) => TOOL_LABEL[t] ?? t).join(", ") : null;
  const kw = c.escalationRules?.keywords?.length ? `Words: ${c.escalationRules.keywords.join(", ")}` : null;
  const hand = [kw, ONE(c.handoffMessage) ? `Says: "${ONE(c.handoffMessage)}"` : null, c.handoffAtQualified ? "Hands over qualified leads" : null].filter(Boolean).join("\n") || null;
  const sp = ONE(c.systemPrompt);
  return [
    { key: "name", label: "Name", value: ONE(d.name), hint: "Asked early on" },
    { key: "persona", label: "Persona", value: sp ? (sp.length > 220 ? `${sp.slice(0, 220)}…` : sp) : null, hint: "Role, scope, tone and rules" },
    { key: "greeting", label: "Greeting", value: ONE(c.greeting), hint: "What customers see first" },
    { key: "handoff", label: "Handoff rules", value: hand, hint: "When to pass to a person" },
    { key: "tools", label: "Tools", value: tools, hint: "Booking, lead capture" },
    { key: "knowledge", label: "Knowledge", value: d.knowledge.length ? d.knowledge.map((k) => k.name).join(", ") : null, hint: "A page or pasted text" },
  ];
}

export const filledCount = (rows: SheetRow[]) => rows.filter((r) => r.value !== null).length;

/** Quick replies belong to the last assistant message, until the owner answers. */
export function activeChips(messages: BuilderMessage[]): string[] {
  const visible = messages.filter((m) => m.role !== "tool");
  const last = visible.at(-1);
  return last?.role === "assistant" ? (last.payload?.ask?.options ?? []) : [];
}

/** Can "Create draft" / "Try it" run? Mirrors the server's finish requirements. */
export const hasDraft = (d: BuilderDraft) => !!d.name && (d.config.systemPrompt?.length ?? 0) >= 40 && !!ONE(d.config.greeting);
