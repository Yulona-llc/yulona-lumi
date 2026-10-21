import { describe, expect, it } from "vitest";
import { widgetUISchema } from "@yulona/shared";
import { normalize, safeUrl } from "../src/render/normalize";

describe("normalize", () => {
  it("renders all five known component types from a valid schema", () => {
    const ui = widgetUISchema.parse({
      version: 1,
      components: [
        { type: "message", text: "hi" },
        { type: "buttons", buttons: [{ label: "A", value: "a" }] },
        { type: "card", title: "T", imageUrl: "https://x.test/a.png" },
        { type: "form", fields: [{ name: "n", label: "N", kind: "text" }] },
        { type: "calendar", timezone: "UTC", slots: [{ start: "2030-01-01T09:00:00Z", end: "2030-01-01T09:30:00Z" }] },
      ],
    });
    expect(normalize(ui, undefined, "m").map((b) => b.type)).toEqual(["message", "buttons", "card", "form", "calendar"]);
  });
  it("degrades unknown types and newer versions without throwing", () => {
    const b = normalize({ version: 9, components: [{ type: "carousel" }, { type: "rating", title: "Rate us" }, null, 5] }, undefined, "m");
    expect(b).toEqual([expect.objectContaining({ type: "message", text: "Rate us" })]);
  });
  it("falls back to plain text, and to nothing for garbage", () => {
    expect(normalize(undefined, "plain", "m")[0]).toMatchObject({ type: "message", text: "plain" });
    expect(normalize("junk", undefined, "m")).toEqual([]);
  });
  it("drops unsafe image urls", () => {
    const [c] = normalize({ components: [{ type: "card", title: "T", imageUrl: "javascript:alert(1)" }] }, undefined, "m");
    expect(c).toMatchObject({ type: "card", imageUrl: undefined });
    expect(safeUrl("data:text/html,x")).toBeUndefined();
  });
});
