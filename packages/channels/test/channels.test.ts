import { describe, expect, test } from "bun:test";
import type { ChannelCapability, WidgetUISchema } from "@yulona/shared";
import { WIDGET_CAPABILITIES, createDefaultRegistry, formatForCapability, isMessageWindowOpen } from "../src";

const textOnly: ChannelCapability = { text: true, richCards: false, forms: false, fileUpload: false, typingIndicator: false, interactiveButtons: false, messageWindow: 24 };
const ui: WidgetUISchema = {
  version: 1,
  components: [
    { type: "message", text: "Pick a time" },
    { type: "calendar", timezone: "UTC", slots: [{ start: "2030-01-01T10:00:00Z", end: "2030-01-01T10:30:00Z" }, { start: "2030-01-01T11:00:00Z", end: "2030-01-01T11:30:00Z" }] },
    { type: "buttons", buttons: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }] },
  ],
};

describe("channels core", () => {
  test("widget adapter registered with full capabilities", () => {
    const r = createDefaultRegistry();
    expect(r.require("widget").capabilities).toEqual(WIDGET_CAPABILITIES);
    expect(r.list().map((a) => a.type).sort()).toEqual(["facebook", "instagram", "slack", "telegram", "whatsapp", "widget"]);
    expect(() => r.register(r.require("widget"))).toThrow();
  });
  test("rich channel keeps components", () => {
    const f = formatForCapability(ui, WIDGET_CAPABILITIES);
    expect(f.degraded).toEqual([]);
    expect(f.ui.components.map((c) => c.type)).toEqual(["message", "calendar", "buttons"]);
  });
  test("text-only channel degrades calendar/buttons to numbered text", () => {
    const f = formatForCapability(ui, textOnly);
    expect(f.degraded).toEqual(["calendar", "buttons"]);
    expect(f.ui.components.every((c) => c.type === "message")).toBe(true);
    expect(f.text).toContain("1. ");
    expect(f.text).toContain("2. No");
  });
  test("message window", () => {
    const now = new Date("2030-01-02T00:00:00Z");
    expect(isMessageWindowOpen(textOnly, new Date("2030-01-01T10:00:00Z"), now)).toBe(true);
    expect(isMessageWindowOpen(textOnly, new Date("2029-12-30T10:00:00Z"), now)).toBe(false);
    expect(isMessageWindowOpen(textOnly, null, now)).toBe(false);
    expect(isMessageWindowOpen(WIDGET_CAPABILITIES, null, now)).toBe(true);
  });
});
