import { WIDGET_UI_SCHEMA_VERSION, type ChannelCapability, type WidgetUIComponent, type WidgetUISchema } from "@yulona/shared";

const fmtSlot = (s: { start: string; end: string }, tz: string) => {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(s.start));
  } catch {
    return s.start;
  }
};

function numbered(items: string[]): string {
  return items.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

/** Plain-text rendition of one component (used for fallbacks and text-only channels). */
export function componentToText(c: WidgetUIComponent): string {
  switch (c.type) {
    case "message":
      return c.text;
    case "buttons":
      return numbered(c.buttons.map((b) => b.label));
    case "card":
      return [c.title, c.body, c.actions?.length ? numbered(c.actions.map((a) => a.label)) : undefined].filter(Boolean).join("\n");
    case "form":
      return c.fields.map((f) => `- ${f.label}${f.required ? " (required)" : ""}`).join("\n");
    case "calendar":
      return numbered(c.slots.slice(0, 10).map((s) => fmtSlot(s, c.timezone)));
  }
}

export function renderPlainText(ui: WidgetUISchema): string {
  return ui.components.map(componentToText).filter(Boolean).join("\n\n");
}

function supports(c: WidgetUIComponent, cap: ChannelCapability): boolean {
  switch (c.type) {
    case "message":
      return cap.text;
    case "buttons":
      return cap.interactiveButtons;
    case "card":
      return cap.richCards;
    case "form":
      return cap.forms;
    case "calendar":
      return cap.richCards && cap.forms;
  }
}

export interface Formatted {
  ui: WidgetUISchema;
  /** Always-present plain text version (message `content`). */
  text: string;
  /** Components that were degraded to text for this channel. */
  degraded: WidgetUIComponent["type"][];
}

/**
 * Capability negotiation: components the channel cannot render become numbered/plain text messages
 * (e.g. calendar on WhatsApp -> numbered slot list). Supported components pass through unchanged.
 */
export function formatForCapability(ui: WidgetUISchema, cap: ChannelCapability): Formatted {
  const degraded: WidgetUIComponent["type"][] = [];
  const out: WidgetUIComponent[] = [];
  for (const c of ui.components) {
    if (supports(c, cap)) {
      out.push(c);
    } else {
      degraded.push(c.type);
      const t = componentToText(c);
      if (t) out.push({ type: "message", text: t.slice(0, 4000) });
    }
  }
  const merged: WidgetUISchema = { version: WIDGET_UI_SCHEMA_VERSION, components: out };
  return { ui: merged, text: renderPlainText(ui), degraded };
}

/** Whether a free-form reply is still allowed given the channel's reply window (hours). */
export function isMessageWindowOpen(cap: ChannelCapability, lastCustomerMessageAt: Date | null | undefined, now = new Date()): boolean {
  if (cap.messageWindow === null) return true;
  if (!lastCustomerMessageAt) return false;
  return now.getTime() - lastCustomerMessageAt.getTime() <= cap.messageWindow * 3_600_000;
}
