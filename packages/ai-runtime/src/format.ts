import { WIDGET_UI_SCHEMA_VERSION, type ChannelCapability, type WidgetUIComponent, type WidgetUISchema } from "@yulona/shared";

/** Plain-text rendition of UI blocks (numbered options for channels without buttons/forms). */
export function renderPlainText(components: WidgetUIComponent[]): string {
  const out: string[] = [];
  for (const c of components) {
    switch (c.type) {
      case "message":
        out.push(c.text);
        break;
      case "buttons":
        out.push(c.buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n"));
        break;
      case "card":
        out.push([c.title, c.body, ...(c.actions ?? []).map((a, i) => `${i + 1}. ${a.label}`)].filter(Boolean).join("\n"));
        break;
      case "form":
        out.push("Please reply with: " + c.fields.map((f) => f.label).join(", "));
        break;
      case "calendar":
        out.push("Available times:\n" + c.slots.slice(0, 5).map((s, i) => `${i + 1}. ${s.start}`).join("\n"));
        break;
    }
  }
  return out.join("\n\n").trim();
}

/**
 * Capability-aware formatting (PLAN §3.2): richer blocks are kept only if the channel supports them,
 * otherwise they degrade to numbered text inside a single message block.
 */
export function formatForChannel(components: WidgetUIComponent[], cap: ChannelCapability): { ui: WidgetUISchema; text: string } {
  const text = renderPlainText(components);
  const supports = (c: WidgetUIComponent): boolean => {
    switch (c.type) {
      case "message": return cap.text;
      case "buttons": return cap.interactiveButtons;
      case "card": return cap.richCards;
      case "form": return cap.forms;
      case "calendar": return cap.forms && cap.richCards;
    }
  };
  if (components.every(supports)) return { ui: { version: WIDGET_UI_SCHEMA_VERSION, components }, text };
  const kept: WidgetUIComponent[] = [];
  const degraded: string[] = [];
  for (const c of components) {
    if (supports(c)) kept.push(c);
    else degraded.push(renderPlainText([c]));
  }
  if (degraded.length) {
    const first = kept.findIndex((c) => c.type === "message");
    const extra = degraded.join("\n\n");
    if (first >= 0) {
      const m = kept[first] as Extract<WidgetUIComponent, { type: "message" }>;
      kept[first] = { ...m, text: `${m.text}\n\n${extra}`.slice(0, 4000) };
    } else kept.push({ type: "message", text: extra.slice(0, 4000) });
  }
  return { ui: { version: WIDGET_UI_SCHEMA_VERSION, components: kept }, text };
}

export function messageBlock(text: string): WidgetUIComponent {
  return { type: "message", text: text.slice(0, 4000) };
}

export function contactFormBlock(fields: ("name" | "email" | "phone")[]): WidgetUIComponent {
  const label = { name: "Your name", email: "Email address", phone: "Phone number" } as const;
  const kind = { name: "text", email: "email", phone: "phone" } as const;
  return {
    type: "form",
    id: "contact_form",
    submitLabel: "Send",
    fields: fields.map((f) => ({ name: f, label: label[f], kind: kind[f], required: true })),
  };
}

/** True if the 24h-style reply window has elapsed. */
export function isWindowExpired(cap: ChannelCapability, lastCustomerMessageAt: Date | null, now = new Date()): boolean {
  if (cap.messageWindow == null || !lastCustomerMessageAt) return false;
  return now.getTime() - lastCustomerMessageAt.getTime() > cap.messageWindow * 3600_000;
}
