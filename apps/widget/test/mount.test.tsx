import { describe, expect, it } from "vitest";
import { mount } from "../src/mount";
import { createMockFetch } from "../src/mock";

const until = async (fn: () => unknown, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("mounted widget (mock backend, jsdom)", () => {
  it("renders in a shadow root, converses, and renders a calendar from schema", async () => {
    const w = mount({ widgetKey: "wk_t", open: true, apiBase: "http://m/api/v1" }, createMockFetch({ latency: 0 }));
    const root = document.querySelector("[data-yulona-widget]")!.shadowRoot!;
    await until(() => root.querySelector(".y-log"));
    await until(() => root.textContent?.includes("Hello! Ask me anything."));
    const ta = root.querySelector("textarea")!;
    ta.value = "book a demo";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => !root.querySelector<HTMLButtonElement>(".y-send")!.disabled);
    root.querySelector("form.y-compose")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await until(() => root.querySelector(".y-cal"), 5000);
    expect(root.querySelector('[role="dialog"]')!.getAttribute("aria-modal")).toBe("true");
    expect(root.querySelector('[role="log"]')!.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelectorAll(".y-slots button").length).toBeGreaterThan(0);
    // host document is untouched (styles/DOM live in the shadow root)
    expect(document.body.querySelector(".y-log")).toBeNull();
    w.destroy();
  });
});
